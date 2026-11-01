"""Real socket collision control in an isolated Docker network namespace."""
import errno
import json
from pathlib import Path
import socket
import sys

fixed=55436;positive=sys.argv[1]=='reserved'
assert Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split()==['55436','55437']
if positive:assert Path('/proc/sys/net/ipv4/ip_local_reserved_ports').read_text().strip()=='55436'
listener=socket.socket();listener.bind(('127.0.0.1',15438));listener.listen(4)
clients=[];accepted=[]
for _ in range(1 if positive else 2):
    client=socket.socket();client.connect(('127.0.0.1',15438));clients.append(client);accepted.append(listener.accept()[0])
ports=[s.getsockname()[1] for s in clients]
server=socket.socket(socket.AF_INET6);server.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,0)
try:server.bind(('::',fixed));bound=True
except OSError as error:assert error.errno==errno.EADDRINUSE;bound=False
if positive:assert ports==[55437] and bound
else:assert fixed in ports and not bound
print(json.dumps({'status':'PASS','reserved':positive,'outgoing_client_ports':ports,'fixed_server_bind_succeeded':bound}))
