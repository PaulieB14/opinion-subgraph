import { Address, BigDecimal, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts"
import {
  ConditionPreparation,
  ConditionResolution,
  PositionSplit,
  PositionsMerge,
  PayoutRedemption,
} from "../generated/ConditionalTokens/ConditionalTokens"
import { Account, CollateralEvent, Market, Position } from "../generated/schema"
import {
  EXCHANGE, USDT, ZERO32, BI_ZERO, BD_ZERO, BD_HALF, toDec, newMarket,
  getAccount, getPosition, positionKey, positionBuy, positionSell, globalPoint,
} from "./common"

export function handleConditionPreparation(event: ConditionPreparation): void {
  let m = Market.load(event.params.conditionId)
  let isNew = m == null
  if (m == null) m = newMarket(event.params.conditionId, event)
  m.questionId = event.params.questionId
  m.oracle = event.params.oracle
  m.outcomeSlotCount = event.params.outcomeSlotCount.toI32()
  m.createdAtBlock = event.block.number
  m.createdAtTimestamp = event.block.timestamp
  m.save()
  if (isNew) {
    let g = globalPoint()
    g.marketsCreated = 1
    g.save()
  }
}

export function handleConditionResolution(event: ConditionResolution): void {
  let m = Market.load(event.params.conditionId)
  if (m == null) return
  let nums = event.params.payoutNumerators
  let den = BI_ZERO
  for (let i = 0; i < nums.length; i++) den = den.plus(nums[i])
  m.resolved = true
  m.payoutNumerators = nums
  m.payoutDenominator = den
  m.resolvedAtTimestamp = event.block.timestamp
  m.save()
}

// Shared gate: top-level (parentCollectionId == 0) USDT positions of a known market.
function gate(conditionId: Bytes, collateral: Address, parent: Bytes): Market | null {
  if (!parent.equals(ZERO32)) return null
  if (!collateral.equals(USDT)) return null
  return Market.load(conditionId)
}

function recordOI(m: Market, delta: BigInt, action: string, stakeholder: Address, amount: BigInt, event: ethereum.Event): void {
  m.openInterestRaw = m.openInterestRaw.plus(delta)
  m.openInterest = toDec(m.openInterestRaw)
  m.save()

  let e = new CollateralEvent(event.transaction.hash.concatI32(event.logIndex.toI32()))
  e.action = action
  e.market = m.id
  e.stakeholder = stakeholder
  e.viaExchange = stakeholder.equals(EXCHANGE)
  e.amount = toDec(amount)
  e.timestamp = event.block.timestamp
  e.blockNumber = event.block.number
  e.transactionHash = event.transaction.hash
  e.save()

  let g = globalPoint()
  g.openInterestDelta = toDec(delta)
  g.save()
}

// A user (not the exchange) splitting USDT receives one share of each outcome:
// treated as buying both at 0.5. Merging is selling both at 0.5.
function userSplitMerge(m: Market, user: Address, amount: BigInt, isSplit: boolean, ts: BigInt): void {
  if (user.equals(EXCHANGE) || m.yesTokenId === null) return
  let account = Account.load(user)
  let pnl = BD_ZERO
  for (let i = 0; i < 2; i++) {
    let tokenId = i == 0 ? (m.yesTokenId as BigInt) : (m.noTokenId as BigInt)
    let p = getPosition(user, m.id, tokenId, i)
    if (isSplit) positionBuy(p, amount, BD_HALF, ts)
    else pnl = pnl.plus(positionSell(p, amount, BD_HALF, ts))
    p.save()
  }
  if (account == null) account = getAccount(user, ts)
  account.realizedPnl = account.realizedPnl.plus(pnl)
  account.save()
}

export function handlePositionSplit(event: PositionSplit): void {
  let p = event.params
  let m = gate(p.conditionId, p.collateralToken, p.parentCollectionId)
  if (m == null) return
  recordOI(m, p.amount, "SPLIT", p.stakeholder, p.amount, event)
  userSplitMerge(m, p.stakeholder, p.amount, true, event.block.timestamp)
}

export function handlePositionsMerge(event: PositionsMerge): void {
  let p = event.params
  let m = gate(p.conditionId, p.collateralToken, p.parentCollectionId)
  if (m == null) return
  recordOI(m, p.amount.neg(), "MERGE", p.stakeholder, p.amount, event)
  userSplitMerge(m, p.stakeholder, p.amount, false, event.block.timestamp)
}

// PayoutRedemption(indexed redeemer, indexed collateralToken, indexed parentCollectionId,
//                  conditionId, indexSets, payout) — conditionId is NOT indexed (verified
// against the Sourcify-verified ABI of 0xAD1a…D774).
export function handlePayoutRedemption(event: PayoutRedemption): void {
  let p = event.params
  let m = gate(p.conditionId, p.collateralToken, p.parentCollectionId)
  if (m == null) return
  recordOI(m, p.payout.neg(), "REDEMPTION", p.redeemer, p.payout, event)

  // Realize PnL: redeemPositions burns the redeemer's whole balance of each redeemed
  // outcome at payoutNumerator / payoutDenominator.
  if (m.yesTokenId === null || m.payoutNumerators === null || m.payoutDenominator === null) return
  let den = m.payoutDenominator as BigInt
  if (den.equals(BI_ZERO)) return
  let nums = m.payoutNumerators as Array<BigInt>
  let account = Account.load(p.redeemer)
  if (account == null) return // never traded: nothing tracked to realize
  let pnl = BD_ZERO
  let indexSets = p.indexSets
  for (let j = 0; j < indexSets.length; j++) {
    let idx = -1
    if (indexSets[j].equals(BigInt.fromI32(1))) idx = 0
    else if (indexSets[j].equals(BigInt.fromI32(2))) idx = 1
    if (idx < 0 || idx >= nums.length) continue
    let tokenId = idx == 0 ? (m.yesTokenId as BigInt) : (m.noTokenId as BigInt)
    let pos = Position.load(positionKey(p.redeemer, tokenId))
    if (pos == null || pos.amountRaw.equals(BI_ZERO)) continue
    let price = nums[idx].toBigDecimal().div(den.toBigDecimal())
    pnl = pnl.plus(positionSell(pos, pos.amountRaw, price, event.block.timestamp))
    pos.save()
  }
  account.realizedPnl = account.realizedPnl.plus(pnl)
  account.save()
}
