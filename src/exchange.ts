import { Address, BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts"
import { TokenRegistered, OrderFilled, FeeCharged, CTFExchange } from "../generated/CTFExchange/CTFExchange"
import { Market, OutcomeToken, Trade, MarketTradePoint } from "../generated/schema"
import {
  EXCHANGE, BI_ZERO, BI_ONE, BD_ZERO, BD_ONE, toDec, tokenKey, newMarket, registerTokens,
  getAccount, getPosition, positionBuy, positionSell, globalPoint,
} from "./common"

export function handleTokenRegistered(event: TokenRegistered): void {
  let conditionId = event.params.conditionId
  let m = Market.load(conditionId)
  if (m == null) m = newMarket(conditionId, event)
  if (registerTokens(m, event.params.token0, event.params.token1)) m.save()
}

// Fallback for a token whose TokenRegistered was not indexed (only possible when
// starting mid-history): look the market up on the exchange.
function loadToken(tokenId: BigInt, event: OrderFilled): OutcomeToken | null {
  let t = OutcomeToken.load(tokenKey(tokenId))
  if (t != null) return t
  let ex = CTFExchange.bind(EXCHANGE)
  let cond = ex.try_getConditionId(tokenId)
  let comp = ex.try_getComplement(tokenId)
  if (cond.reverted || comp.reverted) return null
  let m = Market.load(cond.value)
  if (m == null) m = newMarket(cond.value, event)
  if (registerTokens(m, tokenId, comp.value)) m.save()
  return OutcomeToken.load(tokenKey(tokenId))
}

/**
 * OrderFilled is processed from the order owner's (`maker`) perspective only.
 * A match emits one OrderFilled per maker order (taker = taker-order owner) and one
 * for the taker order itself (taker = exchange), so every participant is seen
 * exactly once per fill. Asset id 0 is collateral (USDT):
 *   makerAssetId == 0  -> owner BUYS  takerAssetId, pays makerAmountFilled USDT
 *   takerAssetId == 0  -> owner SELLS makerAssetId, receives takerAmountFilled USDT
 * Market volume counts maker-order fills only (taker != exchange), so each matched
 * pair is counted once.
 */
export function handleOrderFilled(event: OrderFilled): void {
  let p = event.params
  let isBuy = p.makerAssetId.equals(BI_ZERO)
  let tokenId = isBuy ? p.takerAssetId : p.makerAssetId
  let collateralRaw = isBuy ? p.makerAmountFilled : p.takerAmountFilled
  let sharesRaw = isBuy ? p.takerAmountFilled : p.makerAmountFilled
  if (tokenId.equals(BI_ZERO) || sharesRaw.equals(BI_ZERO)) return

  let token = loadToken(tokenId, event)
  if (token == null) return
  let marketId = token.market
  let outcomeIndex = token.outcomeIndex
  let ts = event.block.timestamp

  let collateral = toDec(collateralRaw)
  let shares = toDec(sharesRaw)
  // OPINION charges the fee in USDT on the taker-order fill. On a BUY the order owner
  // pays makerAmountFilled *including* the fee; on a SELL it receives
  // takerAmountFilled *minus* the fee (verified against USDT transfers on-chain).
  let feeRaw = p.fee.gt(collateralRaw) ? collateralRaw : p.fee
  let sharesBD = sharesRaw.toBigDecimal()
  let netCollateralRaw = collateralRaw.minus(feeRaw)
  // execution price (fee excluded) => always in [0, 1]
  let price = netCollateralRaw.toBigDecimal().div(sharesBD)
  if (!isBuy) price = collateralRaw.toBigDecimal().div(sharesBD)
  // effective price for the owner's cost basis / proceeds (fee included)
  let effPrice = isBuy ? collateralRaw.toBigDecimal().div(sharesBD) : netCollateralRaw.toBigDecimal().div(sharesBD)
  let isTakerFill = p.taker.equals(EXCHANGE)

  let t = new Trade(event.transaction.hash.concatI32(event.logIndex.toI32()))
  t.market = marketId
  t.tokenId = tokenId
  t.outcomeIndex = outcomeIndex
  t.orderHash = p.orderHash
  t.account = p.maker
  t.counterparty = p.taker
  t.isTakerFill = isTakerFill
  t.side = isBuy ? "BUY" : "SELL"
  t.shares = shares
  t.collateral = collateral
  t.price = price
  t.fee = p.fee
  t.feeAmount = toDec(p.fee)
  t.effectivePrice = effPrice
  t.timestamp = ts
  t.blockNumber = event.block.number
  t.transactionHash = event.transaction.hash
  t.save()

  // position + account (order owner)
  let account = getAccount(p.maker, ts)
  let pos = getPosition(p.maker, marketId, tokenId, outcomeIndex)
  if (isBuy) {
    positionBuy(pos, sharesRaw, effPrice, ts)
  } else {
    let pnl = positionSell(pos, sharesRaw, effPrice, ts)
    account.realizedPnl = account.realizedPnl.plus(pnl)
  }
  pos.save()
  account.tradeCount = account.tradeCount.plus(BI_ONE)
  account.volume = account.volume.plus(collateral)
  account.lastTradeTimestamp = ts
  account.save()

  if (isTakerFill) {
    // total fees = OrderFilled.fee (FeeCharged only carries the treasury share;
    // the rest is paid out to a second recipient in the same tx)
    if (p.fee.gt(BI_ZERO)) {
      let gf = globalPoint()
      gf.fees = toDec(p.fee)
      gf.save()
    }
    return
  }

  // market stats: maker-order fills only => each match counted once
  let m = Market.load(marketId)!
  let yesPrice = outcomeIndex == 0 ? price : BD_ONE.minus(price)
  m.volume = m.volume.plus(collateral)
  m.sharesVolume = m.sharesVolume.plus(shares)
  m.tradeCount = m.tradeCount.plus(BI_ONE)
  m.lastYesPrice = yesPrice
  m.lastTradeTimestamp = ts
  m.save()

  let mp = new MarketTradePoint(0)
  mp.market = marketId
  mp.volume = collateral
  mp.shares = shares
  mp.yesPrice = yesPrice
  mp.save()

  let g = globalPoint()
  g.volume = collateral
  g.trades = 1
  g.save()
}

// Fees are paid to the treasury; tokenId 0 means the fee was taken in USDT.
export function handleFeeCharged(event: FeeCharged): void {
  if (!event.params.tokenId.equals(BI_ZERO)) return
  let g = globalPoint()
  g.treasuryFees = toDec(event.params.amount)
  g.save()
}
