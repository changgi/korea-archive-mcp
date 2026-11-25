import json, sys, urllib.request, concurrent.futures as cf
PV="https://korea-archive-mcp.vercel.app/api/mcp"
H={'Content-Type':'application/json','Accept':'application/json, text/event-stream'}
def post(body, sid=None, t=100):
    h=dict(H); 
    if sid: h['Mcp-Session-Id']=sid
    r=urllib.request.urlopen(urllib.request.Request(PV,json.dumps(body).encode(),h),timeout=t)
    return r.headers.get('mcp-session-id'), r.read().decode()
def session():
    sid,_=post({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"s30","version":"1"}}})
    post({"jsonrpc":"2.0","method":"notifications/initialized"},sid); return sid
def call(sid,name,args):
    _,t=post({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":args}},sid)
    for line in t.splitlines():
        line=line.removeprefix('data: ')
        if line.startswith('{'):
            j=json.loads(line); return j.get('result',{}).get('content',[{}])[0].get('text') or json.dumps(j.get('error'))
    return t
if __name__=='__main__':
    jobs=json.load(open(sys.argv[1])); out={}
    sid=session()
    def run(j):
        try: return j['key'], call(sid,j['tool'],j['args'])
        except Exception as e: return j['key'], 'ERR '+str(e)
    with cf.ThreadPoolExecutor(6) as ex:
        for k,v in ex.map(run,jobs): out[k]=v
    json.dump(out,open(sys.argv[2],'w'),ensure_ascii=False,indent=1)
    for k,v in out.items(): print('=====',k,'\n',v[:700])
