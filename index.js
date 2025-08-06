
import { ethers } from 'ethers';
import 'dotenv/config';

const { PRIVATE_KEY, RPC_URL } = process.env;

if (!PRIVATE_KEY || !RPC_URL) {
    console.error("Bruh, you forgot the .env file. Add your PRIVATE_KEY and RPC_URL.");
    process.exit(1);
}

// The amount of ETH to use when an ETH -> Token swap is chosen.
const ETH_AMOUNT_TO_SWAP = "0.0001";

// Pause duration in milliseconds after a full batch of swaps (24 hours)
const PAUSE_DURATION_MS = 24 * 60 * 60 * 1000;

// --- TOKEN ADDRESSES (MegaETH Testnet) ---
// We define all tokens the bot can interact with.
const TOKENS = {
    ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', symbol: 'ETH', decimals: 18, isNative: true },
    WETH: { address: '0x776401b9bc8aae31a685731b7147d4445fd9fb19', symbol: 'WETH', decimals: 18 },
    USDT: { address: '0xe9b6e75c243b6100ffcb1c66e8f78f96feea727f', symbol: 'USDT', decimals: 18 }, // Assuming 18 decimals
    tkUSDC: { address: '0xfaf334e157175ff676911adcf0964d7f54f2c424', symbol: 'tkUSDC', decimals: 6 }, // Common for USDC
    USDC: { address: '0x8d635c4702ba38b1f1735e8e784c7265dcc0b623', symbol: 'USDC', decimals: 6 }, // Common for USDC
    tkETH: { address: '0x176735870dc6c22b4ebfbf519de2ce758de78d94', symbol: 'tkETH', decimals: 18 },
    tkWBTC: { address: '0xf82ff0799448630eb56ce747db840a2e02cde4d8', symbol: 'tkWBTC', decimals: 8 }, // Common for WBTC
    MEGA: { address: '0x10a6be7d23989d00d528e68cf8051d095f741145', symbol: 'MEGA', decimals: 18 },
    GTE: { address: '0x9629684df53db9e4484697d0a50c442b2bfa80a8', symbol: 'GTE', decimals: 18 },
};

// --- ABIS ---
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)"
];

const ROUTER_ABI = [
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
    "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
];

// --- INITIALIZATION ---
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const routerContract = new ethers.Contract('0xA6b579684E943F7D00d616A48cF99b5147fC57A5', ROUTER_ABI, wallet);

console.log(`Auto-swap bot is running.`);
console.log(`Wallet Address: ${wallet.address}`);
console.log(`RPC Endpoint: ${RPC_URL}`);

// --- HELPER FUNCTIONS ---

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Gets the balance of a specific token for the bot's wallet.
 * @param {object} token - The token object from the TOKENS list.
 * @returns {Promise<bigint>} The balance of the token.
 */
async function getBalance(token) {
    if (token.isNative) {
        return provider.getBalance(wallet.address);
    }
    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    return contract.balanceOf(wallet.address);
}

/**
 * Generates a list of all possible swaps based on current wallet balances.
 */
async function getPossibleSwaps() {
    const possibleSwaps = [];
    const balances = {};

    console.log("  > Checking balances...");

    for (const symbol in TOKENS) {
        if (symbol === 'WETH') continue; // We don't trade WETH directly
        balances[symbol] = await getBalance(TOKENS[symbol]);
        console.log(`    - ${symbol}: ${ethers.formatUnits(balances[symbol], TOKENS[symbol].decimals)}`);
    }

    const ethBalance = balances['ETH'];
    const minEthForSwap = ethers.parseEther(ETH_AMOUNT_TO_SWAP);

    // Check for ETH -> Token swaps
    if (ethBalance > minEthForSwap) {
        for (const symbolOut in TOKENS) {
            if (TOKENS[symbolOut].isNative || symbolOut === 'WETH') continue;
            possibleSwaps.push({ from: 'ETH', to: symbolOut, amount: minEthForSwap });
        }
    }

    // Check for Token -> ETH and Token -> Token swaps
    for (const symbolIn in TOKENS) {
        if (TOKENS[symbolIn].isNative || symbolIn === 'WETH') continue;
        if (balances[symbolIn] > 0n) { // If there is any balance
            // Add Token -> ETH
            possibleSwaps.push({ from: symbolIn, to: 'ETH', amount: balances[symbolIn] });

            // Add Token -> Other Tokens
            for (const symbolOut in TOKENS) {
                if (TOKENS[symbolOut].isNative || symbolOut === 'WETH' || symbolIn === symbolOut) continue;
                possibleSwaps.push({ from: symbolIn, to: symbolOut, amount: balances[symbolIn] });
            }
        }
    }

    return possibleSwaps;
}


/**
 * Executes a swap based on the provided trade details.
 * @param {object} trade - An object defining the swap { from, to, amount }.
 */
async function executeSwap(trade) {
    const tokenIn = TOKENS[trade.from];
    const tokenOut = TOKENS[trade.to];

    console.log(`Attempting to swap ${ethers.formatUnits(trade.amount, tokenIn.decimals)} ${tokenIn.symbol} for ${tokenOut.symbol}...`);

    try {
        const deadline = Math.floor(Date.now() / 1000) + 60 * 5; // 5 minute deadline
        let tx;

        if (tokenIn.isNative) {
            // ETH -> Token
            const path = [TOKENS.WETH.address, tokenOut.address];
            tx = await routerContract.swapExactETHForTokens(0, path, wallet.address, deadline, {
                value: trade.amount,
                gasLimit: 400000
            });
        } else if (tokenOut.isNative) {
            // Token -> ETH
            const tokenInContract = new ethers.Contract(tokenIn.address, ERC20_ABI, wallet);
            console.log(`  > Approving ${tokenIn.symbol} for swap...`);
            const approveTx = await tokenInContract.approve(routerContract.target, trade.amount);
            await approveTx.wait();
            console.log(`  > Approval successful.`);
            await delay(3000);

            const path = [tokenIn.address, TOKENS.WETH.address];
            tx = await routerContract.swapExactTokensForETH(trade.amount, 0, path, wallet.address, deadline, {
                gasLimit: 400000
            });
        } else {
            // Token -> Token
            const tokenInContract = new ethers.Contract(tokenIn.address, ERC20_ABI, wallet);
            console.log(`  > Approving ${tokenIn.symbol} for swap...`);
            const approveTx = await tokenInContract.approve(routerContract.target, trade.amount);
            await approveTx.wait();
            console.log(`  > Approval successful.`);
            await delay(3000);

            const path = [tokenIn.address, tokenOut.address];
            tx = await routerContract.swapExactTokensForTokens(trade.amount, 0, path, wallet.address, deadline, {
                gasLimit: 500000 // Token-token might need more gas
            });
        }

        console.log(`  > Swap transaction sent: ${tx.hash}`);
        await tx.wait();
        console.log(`  > Swap successful!`);
        return true;

    } catch (error) {
        console.error("  > ERROR during swap:", error.reason || error.message);
        return false;
    }
}


/**
 * The main logic loop for the bot.
 */
async function runBot() {
    while (true) {
        const cyclesForThisBatch = Math.floor(Math.random() * 11) + 10;
        console.log(`\n--- Starting New Batch: Targetting ${cyclesForThisBatch} Swap Cycles ---`);

        for (let i = 1; i <= cyclesForThisBatch; i++) {
            console.log(`\n--- Cycle ${i} of ${cyclesForThisBatch} ---`);

            const possibleSwaps = await getPossibleSwaps();

            if (possibleSwaps.length === 0) {
                console.log("  > No possible swaps with current balances. Waiting before re-checking.");
                await delay(60000); // Wait 1 minute and check again
                continue;
            }

            // Select a random swap from the possible options
            const randomSwap = possibleSwaps[Math.floor(Math.random() * possibleSwaps.length)];
            
            await executeSwap(randomSwap);

            console.log(`--- End of Cycle ${i} ---`);
            // Brief pause between individual cycles
            await delay(5000);
        }

        console.log(`\nAll cycles for this batch are complete.`);
        console.log(`Now starting 24-hour pause...`);
        console.log(`Next batch will start around: ${new Date(Date.now() + PAUSE_DURATION_MS).toLocaleString()}`);
        await delay(PAUSE_DURATION_MS);
    }
}

// Kick off the bot
runBot().catch(error => {
    console.error("A critical, unrecoverable error occurred in the bot's main loop:", error);
    process.exit(1);
});
