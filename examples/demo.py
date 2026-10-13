#!/usr/bin/env python3
"""OPINION subgraph + Open API combo demo: titles from the API, on-chain stats from the subgraph.
Usage: python3 demo.py   (no API key needed; builds/uses apiidx.json cache of questionId -> title)"""
import json,os,requests,concurrent.futures as cf
SG="https://api.studio.thegraph.com/query/111767/opinion-prediction-market/v0.1.1"
API="https://openapi.opinion.trade/openapi/market"
def gq(q): return requests.post(SG,json={"query":q},timeout=60).json()["data"]
def page(a):
  st,p=a
  for _ in range(4):
    try: return requests.get(API,params={"limit":20,"page":p,"status":st,"marketType":2},timeout=30).json()["result"]["list"] or []
    except Exception: pass
  return []
def titles(cache="apiidx.json"):
  if os.path.exists(cache): return json.load(open(cache))
  idx={}
  for st in ["activated","resolved"]:
    tot=requests.get(API,params={"limit":20,"page":1,"status":st,"marketType":2},timeout=30).json()["result"]["total"]
    with cf.ThreadPoolExecutor(12) as ex:
      for l in ex.map(page,[(st,p) for p in range(1,tot//20+2)]):
        for x in l:   # multi-outcome parents carry their sub-markets in childMarkets
          for c in [x]+(x.get("childMarkets") or []):
            q=(c.get("questionId") or "").lower().replace("0x","")
            if q: idx[q]={"title":c["marketTitle"],"parent":x["marketTitle"] if c is not x else None,"status":c.get("statusEnum") or st,"volume":c.get("volume")}
  json.dump(idx,open(cache,"w")); return idx
def name(idx,qid):
  a=idx.get(qid[2:].lower())
  if not a: return "(unlisted) "+qid[:10]
  return (a["parent"]+" → "+a["title"]) if a["parent"] else a["title"]
def main():
  idx=titles()
  g=gq('{globalStats(interval:day,first:1){totalVolume totalMarkets openInterest}}')["globalStats"][0]
  print("## Protocol\n\nVolume indexed: $%.2fB | markets: %d | open interest: $%.2fM\n"%(float(g["totalVolume"])/1e9,g["totalMarkets"],float(g["openInterest"])/1e6))
  ms=gq('{markets(first:10,orderBy:volume,orderDirection:desc){questionId volume openInterest tradeCount lastYesPrice resolved}}')["markets"]
  print("## Top 10 markets by volume\n\n| Market (API title) | Volume (sg) | OI | Fills | Last YES | Status |\n|---|---|---|---|---|---|")
  for m in ms:
    a=idx.get(m["questionId"][2:].lower()) or {}
    print("| %s | $%.1fM | $%.0fk | %s | %.3f | %s |"%(name(idx,m["questionId"])[:70],float(m["volume"])/1e6,float(m["openInterest"])/1e3,m["tradeCount"],float(m["lastYesPrice"]),a.get("status","?")))
  w=gq('{accounts(first:1,orderBy:realizedPnl,orderDirection:desc){id realizedPnl volume tradeCount}}')["accounts"][0]
  print("\n## Top wallet by realized PnL: `%s`\n\nRealized PnL $%.0f on $%.1fM volume, %s fills\n"%(w["id"],float(w["realizedPnl"]),float(w["volume"])/1e6,w["tradeCount"]))
  ps=gq('{positions(first:8,orderBy:realizedPnl,orderDirection:desc,where:{account:"%s"}){realizedPnl outcomeIndex totalBought market{questionId}}}'%w["id"])["positions"]
  print("| Market | Side | Bought | Realized PnL |\n|---|---|---|---|")
  for p in ps:
    print("| %s | %s | $%.0f | $%.0f |"%(name(idx,p["market"]["questionId"])[:70],"YES" if p["outcomeIndex"]==0 else "NO",float(p["totalBought"]),float(p["realizedPnl"])))
if __name__=="__main__": main()
