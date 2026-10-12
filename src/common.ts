import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import { Account, Market, OutcomeToken, Position, GlobalDataPoint } from "../generated/schema"
import { ConditionalTokens } from "../generated/ConditionalTokens/ConditionalTokens"

export const EXCHANGE = Address.fromString("0x5F45344126D6488025B0b84A3A8189F2487a7246")
export const CTF = Address.fromString("0xAD1a38cEc043e70E83a3eC30443dB285ED10D774")
// BSC USDT (BEP20) — 18 decimals, OPINION's only quote token
export const USDT = Address.fromString("0x55d398326f99059fF775485246999027B3197955")
export const ZERO32 = Bytes.fromHexString("0x0000000000000000000000000000000000000000000000000000000000000000")

export const BI_ZERO = BigInt.zero()
export const BI_ONE = BigInt.fromI32(1)
export const BD_ZERO = BigDecimal.zero()
export const ONE_E18 = BigInt.fromString("1000000000000000000").toBigDecimal()
export const BD_HALF = BigDecimal.fromString("0.5")
export const BD_ONE = BigDecimal.fromString("1")

export function toDec(raw: BigInt): BigDecimal {
  return raw.toBigDecimal().div(ONE_E18)
}

export function tokenKey(tokenId: BigInt): Bytes {
  return Bytes.fromByteArray(Bytes.fromBigInt(tokenId)) // compact, unique per id
}

export function positionKey(account: Address, tokenId: BigInt): Bytes {
  return account.concat(tokenKey(tokenId))
}

export function newMarket(conditionId: Bytes, event: ethereum.Event): Market {
  let m = new Market(conditionId)
  m.questionId = ZERO32
  m.oracle = Address.zero()
  m.outcomeSlotCount = 2
  m.resolved = false
  m.volume = BD_ZERO
  m.sharesVolume = BD_ZERO
  m.tradeCount = BI_ZERO
  m.openInterest = BD_ZERO
  m.openInterestRaw = BI_ZERO
  m.lastYesPrice = BD_ZERO
  m.lastTradeTimestamp = BI_ZERO
  m.createdAtBlock = event.block.number
  m.createdAtTimestamp = event.block.timestamp
  return m
}

/**
 * Register both outcome tokens of a binary market. The exchange emits
 * TokenRegistered twice per market (A,B) and (B,A), so the outcome index is
 * resolved on-chain once: positionId(USDT, collectionId(0, conditionId, indexSet=1))
 * is outcome 0 = YES. Returns false if the market already has tokens.
 */
export function registerTokens(market: Market, tokenA: BigInt, tokenB: BigInt): boolean {
  if (market.yesTokenId !== null) return false
  let aIsZero = true
  let ctf = ConditionalTokens.bind(CTF)
  let coll = ctf.try_getCollectionId(ZERO32, market.id, BI_ONE)
  if (!coll.reverted) {
    let pos = ctf.try_getPositionId(USDT, coll.value)
    if (!pos.reverted && pos.value.equals(tokenB)) aIsZero = false
  }
  let t0 = aIsZero ? tokenA : tokenB
  let t1 = aIsZero ? tokenB : tokenA
  market.yesTokenId = t0
  market.noTokenId = t1
  let ot0 = new OutcomeToken(tokenKey(t0))
  ot0.tokenId = t0
  ot0.market = market.id
  ot0.outcomeIndex = 0
  ot0.save()
  let ot1 = new OutcomeToken(tokenKey(t1))
  ot1.tokenId = t1
  ot1.market = market.id
  ot1.outcomeIndex = 1
  ot1.save()
  return true
}

export function getAccount(addr: Address, ts: BigInt): Account {
  let a = Account.load(addr)
  if (a == null) {
    a = new Account(addr)
    a.tradeCount = BI_ZERO
    a.volume = BD_ZERO
    a.realizedPnl = BD_ZERO
    a.firstTradeTimestamp = ts
    a.lastTradeTimestamp = ts
  }
  return a as Account
}

export function getPosition(account: Address, market: Bytes, tokenId: BigInt, outcomeIndex: i32): Position {
  let id = positionKey(account, tokenId)
  let p = Position.load(id)
  if (p == null) {
    p = new Position(id)
    p.account = account
    p.market = market
    p.tokenId = tokenId
    p.outcomeIndex = outcomeIndex
    p.amountRaw = BI_ZERO
    p.amount = BD_ZERO
    p.avgPrice = BD_ZERO
    p.totalBought = BD_ZERO
    p.totalSold = BD_ZERO
    p.realizedPnl = BD_ZERO
    p.lastUpdatedTimestamp = BI_ZERO
  }
  return p as Position
}

/** Add shares at a price (weighted-average cost basis). */
export function positionBuy(p: Position, sharesRaw: BigInt, price: BigDecimal, ts: BigInt): void {
  let oldNotional = p.amountRaw.toBigDecimal().times(p.avgPrice)
  let newAmount = p.amountRaw.plus(sharesRaw)
  p.avgPrice = newAmount.equals(BI_ZERO)
    ? BD_ZERO
    : oldNotional.plus(sharesRaw.toBigDecimal().times(price)).div(newAmount.toBigDecimal())
  p.amountRaw = newAmount
  p.amount = toDec(newAmount)
  p.totalBought = p.totalBought.plus(toDec(sharesRaw))
  p.lastUpdatedTimestamp = ts
}

/** Remove shares at a price; realize PnL against cost basis (clamped to holdings). Returns the PnL delta in USDT. */
export function positionSell(p: Position, sharesRaw: BigInt, price: BigDecimal, ts: BigInt): BigDecimal {
  let against = p.amountRaw.lt(sharesRaw) ? p.amountRaw : sharesRaw
  let pnl = price.minus(p.avgPrice).times(toDec(against))
  p.realizedPnl = p.realizedPnl.plus(pnl)
  p.amountRaw = p.amountRaw.minus(against)
  p.amount = toDec(p.amountRaw)
  p.totalSold = p.totalSold.plus(toDec(sharesRaw))
  p.lastUpdatedTimestamp = ts
  return pnl
}

export function globalPoint(): GlobalDataPoint {
  let g = new GlobalDataPoint(0) // id is auto-assigned for timeseries
  g.volume = BD_ZERO
  g.trades = 0
  g.fees = BD_ZERO
  g.openInterestDelta = BD_ZERO
  g.marketsCreated = 0
  return g
}
