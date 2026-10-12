# OPINION Subgraph (BNB Chain)

A subgraph for [OPINION](https://opinion.trade), a prediction market on BNB Chain. It covers markets, every order fill, per-wallet positions with cost basis and realized PnL, splits/merges/redemptions, per-market open interest, and hourly/daily stats for each market and for the whole protocol.

OPINION uses the same design as Polymarket V1: Gnosis-style ConditionalTokens (ERC1155 outcome tokens), a CTF Exchange that settles off-chain-matched orders, Safe proxy wallets, and a single collateral, **BSC USDT (18 decimals)**.

## Contracts (BNB Chain, chain id 56)

| Contract | Address | Start block | Source |
|---|---|---|---|
| ConditionalTokens | `0xAD1a38cEc043e70E83a3eC30443dB285ED10D774` | 64,726,315 (deployment) | docs.opinion.trade SDK config; Sourcify-verified ABI |
| CTF Exchange ("OPINION CTF Exchange") | `0x5F45344126D6488025B0b84A3A8189F2487a7246` | 65,487,738 (deployment) | `openapi.opinion.trade/openapi/quoteToken` (`ctfExchangeAddress`); `getCtf()` on it returns the CTF above; Sourcify-verified ABI |
| Collateral: USDT (BEP20) | `0x55d398326f99059fF775485246999027B3197955` | n/a | `getCollateral()` on the exchange; the only quote token the API lists (decimals 18) |

The exchange is the only ERC1155 operator seen on the CTF, and OPINION has no NegRisk adapter. Multi-outcome markets are groups of binary conditions.

### IDs and the Open API

- `Market.id` is the CTF `conditionId`, `questionId` is the on-chain question id, and `yesTokenId`/`noTokenId` are the ERC1155 position ids. All three match the [Open API](https://docs.opinion.trade/developer-guide/opinion-open-api) fields with the same names. I checked market 2636: `positionId(USDT, collectionId(0, conditionId, indexSet 1))` equals the API's `yesTokenId`.
- The Open API `marketId` (an integer) and the market titles exist only off-chain. Categorical markets are groups of binary child markets, each with its own condition.
- Resolution goes through OPINION's DisputeResolver contracts, which aren't indexed here. The final payout comes from the CTF's `ConditionResolution` (`payoutNumerators` is `[yes, no]`).

## What it indexes

| Entity | Description |
|---|---|
| `Market` | One CTF condition: question id, oracle, YES/NO outcome token ids (YES = outcome index 0), resolution payouts, matched volume, trade count, open interest, and the last YES price |
| `OutcomeToken` | Maps an ERC1155 token id to its market and outcome index |
| `Trade` | Every `OrderFilled`, from the order owner's perspective: side, shares, USDT, fee-excluded `price`, all-in `effectivePrice`, and `fee`/`feeAmount` |
| `Account` | A wallet (usually a Safe proxy) with trade count, volume, and realized PnL |
| `Position` | Account × outcome token: net shares, weighted-average cost, totals bought and sold, and realized PnL |
| `CollateralEvent` | USDT split, merge, or redemption (`viaExchange` marks mint/merge matches done by the exchange) |
| `GlobalStat` (hour/day) | Volume, trades, all fees + treasury fees, open interest (cumulative), markets created, and total volume |
| `MarketStat` (hour/day) | Per-market volume, shares, trades, and YES-price OHLC |

### Methodology

- **Fills.** A match emits one `OrderFilled` per maker order (taker = the taker-order owner) plus one for the taker order (taker = the exchange). Each event is applied only to the order owner (`maker`), so every participant is counted exactly once. Asset id `0` is USDT: `makerAssetId == 0` is a BUY of `takerAssetId`, and otherwise it's a SELL of `makerAssetId`.
- **Volume** (market and global) counts maker-order fills only, so each matched pair is counted once. `Account.volume` is the USDT that account itself paid or received.
- **PnL** uses weighted-average cost basis, the same method as `polymarket-v2-subgraphs/pnl`. Sells realize `(price - avgPrice) × shares`, capped at the shares held. Direct user splits and merges count as buying or selling both outcomes at 0.50. Redemptions realize the held shares at `payoutNumerator / payoutDenominator`. Plain ERC1155 transfers between wallets aren't tracked.
- **Open interest** = USDT split − merged − redeemed on top-level (`parentCollectionId == 0`) USDT positions of OPINION markets.
- **Fees.** `Trade.fee` / `feeAmount` come from `OrderFilled.fee` (all trading fees). `price` is fee-excluded (0..1); `effectivePrice` is the owner's all-in price used for cost basis / PnL (BUY adds the fee, SELL subtracts it). Protocol `fees` sum `OrderFilled.fee`; `treasuryFees` sum `FeeCharged` with `tokenId == 0` (treasury share only).
- `PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId, conditionId, indexSets, payout)`: `conditionId` is **not** indexed. This was checked against the verified ABI.
- To keep writes low, there's no global singleton. Protocol-wide numbers come from timeseries aggregations, and `TransferSingle`/`TransferBatch` aren't indexed.

## Example queries

```graphql
# Most-traded markets
{
  markets(first: 10, orderBy: volume, orderDirection: desc) {
    id questionId volume tradeCount openInterest lastYesPrice resolved payoutNumerators
  }
}

# Daily protocol stats (fees = all OrderFilled fees; treasuryFees = FeeCharged share)
{
  globalStats(interval: "day", first: 30) {
    timestamp volume trades fees treasuryFees openInterest totalMarkets totalVolume
  }
}

# Daily candles for one market
{
  marketStats(interval: "day", where: { market: "0x…conditionId" }, first: 30) {
    timestamp volume trades openYesPrice closeYesPrice highYesPrice lowYesPrice
  }
}

# A wallet's positions and PnL
{
  account(id: "0x…wallet") {
    tradeCount volume realizedPnl
    positions(where: { amountRaw_gt: "0" }) { market { id } outcomeIndex amount avgPrice realizedPnl }
  }
}

# Latest fills (price is fee-excluded; effectivePrice is all-in for PnL)
{
  trades(first: 20, orderBy: timestamp, orderDirection: desc, where: { isTakerFill: false }) {
    market { id } account { id } side outcomeIndex shares collateral
    price effectivePrice feeAmount transactionHash
  }
}

# Fee-aware fills (largest fees; taker fills usually carry the fee)
{
  trades(first: 20, orderBy: feeAmount, orderDirection: desc, where: { feeAmount_gt: "0" }) {
    market { id } account { id } side isTakerFill shares collateral
    price effectivePrice feeAmount
  }
}

# Protocol fees vs treasury take, by day
{
  globalStats(interval: "day", first: 14, orderBy: timestamp, orderDirection: desc) {
    timestamp volume fees treasuryFees trades
  }
}

# Trades where all-in price differs from execution price (fee impact)
{
  trades(first: 20, orderBy: timestamp, orderDirection: desc, where: { feeAmount_gt: "0" }) {
    side price effectivePrice feeAmount shares collateral transactionHash
  }
}
```

## Development

```bash
npm install
npm run codegen && npm run build
graph deploy opinion-bnb --version-label v0.1.0   # Subgraph Studio
```
