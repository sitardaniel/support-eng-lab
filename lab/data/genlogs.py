import json, random, datetime as dt
random.seed(7)
start = dt.datetime(2026,10,1,8,0,0)
out = []
def log(t, svc, lvl, msg, **kw):
    out.append(dict(ts=t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]+"Z", service=svc, level=lvl, msg=msg, **kw))
for i in range(3600):
    t = start + dt.timedelta(seconds=i)
    m = i // 60
    rid = "req-%05d" % i
    if 25 <= m < 34 and random.random() < 0.8:
        log(t, "collector", "ERROR", "mongo write failed: connection timeout", host="mongo-0.mongo", request_id=rid)
    else:
        log(t, "collector", "INFO", "batch stored", docs=random.randint(50,200), request_id=rid)
    if i % 10 == 0:
        lag = 400 + (m-26)*900 if 26 <= m < 34 else 6700 - (m-33)*1100 if 34 <= m < 40 else 40 + random.randint(0,20)
        log(t, "enricher", "WARN" if lag > 1000 else "INFO", "consumer lag", topic="events", lag=lag)
    status = 200
    if 28 <= m < 38 and random.random() < 0.35: status = 503
    elif random.random() < 0.01: status = 404
    log(t, "api", "ERROR" if status == 503 else "INFO", "GET /v1/search", status=status, latency_ms=random.randint(20,90) if status==200 else random.randint(2900,3100), request_id=rid)
    if i == 25*60+0:
        log(t, "mongo", "WARN", "replica set member unreachable", member="mongo-1.mongo:27017")
    if i == 24*60+20:
        log(t, "node", "WARN", "disk usage 91% on /var/lib/mongo")
out.sort(key=lambda r: r["ts"])
with open("bundle.jsonl","w") as f:
    for r in out: f.write(json.dumps(r)+"\n")
