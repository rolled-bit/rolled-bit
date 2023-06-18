import fs from "fs";

import axios from "axios";
import { Chain, Common, Hardfork } from "@ethereumjs/common";
import { Transaction } from "@ethereumjs/tx";
import { VM } from "@ethereumjs/vm";
import { Account, Address } from "@ethereumjs/util";
import { DefaultStateManager } from "@ethereumjs/statemanager";
import { Trie } from "@ethereumjs/trie";
import { Level } from "level";
import { LevelDB } from "../lib/level.js";

import config from "../../config.js";
import { decodeTransaction, encodeTransaction, signTx, txObjToEthTxObj, verifyTxSig } from "./txn.js";
import { decodeBatch, encodeBatch } from "./batch.js";
import { transitState } from "./runtime.js";
import { rpc } from "../rpc/rpc.js";

// Init constants

process.on("uncaughtException", err => console.log(err));

const { 
    BTC_PRIVKEY,
    BTC_RPC_USERNAME,
    BTC_RPC_PASSWORD,
    BTC_RPC_URL,
    PRIVKEY,
    SEQUENCER_URL, 
    SEQUENCER_ADDRESS, 
    SEQUENCER_MODE,
    ROLLUP_ADDRESS, 
    START_SYNC, 
    RPC_PORT,
    LEVEL_PATH,
    LOG_FILE,
    FIRST_MINT_ADDR,
    ADDRESS_DB_PATH,
    INDEX_DB_PATH
} = config;

// Init EVM + state storage

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Berlin });

const trie = await Trie.create({
    db: new LevelDB(new Level(LEVEL_PATH)),
    useKeyHashing: true,
    useRootPersistence: true,
})

const stateManager = new DefaultStateManager({ trie });

const vm = await VM.create({ common, stateManager });

const addressDB = new Level(ADDRESS_DB_PATH);
const indexDB = new Level(INDEX_DB_PATH);

// Init current sync height

let counter, currentIndex = 0;

if (!fs.existsSync(LOG_FILE)) {
    counter = START_SYNC;

    // Initial coin mint
    const address = new Address(Buffer.from(FIRST_MINT_ADDR.slice(2), "hex"));
    const account = new Account(0n, 10000000000000000000000000n);
    await vm.stateManager.checkpoint();
    await vm.stateManager.putAccount(address, account);
    await vm.stateManager.commit();
    await vm.stateManager.flush();

    // Initial address indexing
    await addressDB.put("0", FIRST_MINT_ADDR.slice(2));
    await indexDB.put(FIRST_MINT_ADDR.slice(2), "0");

    fs.writeFileSync(LOG_FILE, JSON.stringify({
        counter,
        currentIndex
    }));
} else {
    const log = JSON.parse(fs.readFileSync(LOG_FILE));

    counter = log.counter;
    currentIndex = log.currentIndex;
}

// Sync rollup blocks

async function callRpcMethod(method, params = []) {
    try {
        const response = await axios.post(BTC_RPC_URL, {
            jsonrpc: '2.0',
            id: 'curltest',
            method: method,
            params: params,
        }, {
            auth: {
                username: BTC_RPC_USERNAME,
                password: BTC_RPC_PASSWORD,
            }
        });
    
        return response.data.result;
    } catch (error) {
      console.error('Error calling RPC method:', error);
    }
}

async function sync() {
    try {
        const blockHash = await callRpcMethod("getblockhash", [115]);

        const block = await callRpcMethod("getblock", [blockHash, 2]);

        const transactions = block.tx;

        for (const transaction of transactions) {
            for (const output of transaction.vout) {
                // Check if recipient is the rollup address
                if (
                    output.scriptPubKey && 
                    output.scriptPubKey.address && 
                    output.scriptPubKey.hex &&
                    output.scriptPubKey.address === ROLLUP_ADDRESS 
                ) {
                    try {
                        let batchHex = "";
                        batchHex += output.scriptPubKey.hex;

                        console.log(batchHex);
                    } catch (e) {
                        // Debug
                        console.log(e);
                    }
                }
            }
        }
    } catch (error) {
        console.error("LOG :: Error fetching block:", error);
        // Re-sync block
        setTimeout(sync);
    }

    counter++;

    fs.writeFileSync(LOG_FILE, JSON.stringify({
        counter,
        currentIndex
    }));

    // setTimeout(sync);
}

await sync();


const transactionPool = [];

// RPC

rpc(RPC_PORT, { vm, transactionPool, config, addressDB, indexDB, trie });

const transaction = {
    isToEmpty: 0,
    to: "029B93211e7793759534452BDB1A74b58De22C9c",
    data: "",
    nonce: 0,
    gas: 2097152,
    gasPrice: 33554432,
    value: 320000000n
}

const tx = signTx(transaction, Buffer.from(PRIVKEY.slice(2), "hex"));
const raw = (await encodeTransaction(tx, indexDB)).slice(2);

const utxos = await callRpcMethod("listunspent", []);
// Absolutely dumb, only using this for testing
const topUtxo = utxos[utxos.length - 1];

const rawTransaction = await callRpcMethod('createrawtransaction', [
    [
        {
            txid: topUtxo.txid,
            vout: topUtxo.vout
        }
    ],
]);

/*
// Sequencers

if (SEQUENCER_MODE) {
    // Do sequencer stuff

    setInterval(async () => {
        if (transactionPool.length === 0) return;


        // Remove sequenced transactions
        transactionPool.splice(0, 100);
    }, 5000);
    // Sequencers don't necessarily need to wait for 5 seconds before submitting another batch, 
    // but we currently do this to reduce the work load in case of high traffic
}
*/
