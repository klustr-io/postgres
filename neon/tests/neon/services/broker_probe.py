"""Exercise actual broker streaming, tenant/type filtering and bad IDs."""
from concurrent.futures import ThreadPoolExecutor
import time
from urllib.request import urlopen
import grpc
from google.protobuf.empty_pb2 import Empty
import broker_pb2 as p
import broker_pb2_grpc as rpc

def metrics():
    return urlopen("http://127.0.0.1:50051/metrics", timeout=3).read().decode()

def wait_metric(name):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if f"{name} 1" in metrics():
            return
        time.sleep(0.05)
    raise AssertionError(f"Subscription did not become active: {name}")

tenant = p.TenantTimelineId(tenant_id=b"a"*16, timeline_id=b"b"*16)
other = p.TenantTimelineId(tenant_id=b"c"*16, timeline_id=b"d"*16)
with grpc.insecure_channel("127.0.0.1:50051") as channel, ThreadPoolExecutor(max_workers=1) as pool:
    grpc.channel_ready_future(channel).result(timeout=5)
    client = rpc.BrokerServiceStub(channel)
    stream = client.SubscribeSafekeeperInfo(p.SubscribeSafekeeperInfoRequest(all=Empty()), timeout=10)
    received = pool.submit(next, stream)
    wait_metric("storage_broker_all_keys_active_subscribers")
    message = p.SafekeeperTimelineInfo(safekeeper_id=42, tenant_timeline_id=tenant,
        term=3, last_log_term=3, flush_lsn=1024, commit_lsn=512, safekeeper_connstr="test:5454")
    client.PublishSafekeeperInfo(iter([message]), timeout=5)
    assert received.result(timeout=5) == message
    stream.cancel()
    print("PASS: streaming safekeeper publication/subscription preserves IDs, terms and LSNs")

    stream = client.SubscribeByFilter(p.SubscribeByFilterRequest(
        types=[p.TypeSubscription(type=p.SAFEKEEPER_DISCOVERY_RESPONSE)],
        tenant_timeline_id=p.FilterTenantTimelineId(enabled=True, tenant_timeline_id=tenant)), timeout=10)
    received = pool.submit(next, stream)
    wait_metric("storage_broker_per_timeline_active_subscribers")
    client.PublishOne(p.TypedMessage(type=p.SAFEKEEPER_DISCOVERY_RESPONSE,
        safekeeper_discovery_response=p.SafekeeperDiscoveryResponse(safekeeper_id=99, tenant_timeline_id=other)), timeout=5)
    client.PublishOne(p.TypedMessage(type=p.SAFEKEEPER_DISCOVERY_REQUEST,
        safekeeper_discovery_request=p.SafekeeperDiscoveryRequest(tenant_timeline_id=tenant)), timeout=5)
    expected = p.TypedMessage(type=p.SAFEKEEPER_DISCOVERY_RESPONSE,
        safekeeper_discovery_response=p.SafekeeperDiscoveryResponse(safekeeper_id=43, tenant_timeline_id=tenant, commit_lsn=2048))
    client.PublishOne(expected, timeout=5)
    assert received.result(timeout=5) == expected
    stream.cancel()
    print("PASS: tenant/timeline and message-type filters exclude unrelated broadcasts")

    malformed = client.SubscribeSafekeeperInfo(p.SubscribeSafekeeperInfoRequest(
        tenant_timeline_id=p.TenantTimelineId(tenant_id=b"short", timeline_id=b"b"*16)), timeout=5)
    try:
        next(malformed)
    except grpc.RpcError as error:
        assert error.code() == grpc.StatusCode.INVALID_ARGUMENT
    else:
        raise AssertionError("Malformed tenant ID was accepted")
    print("PASS: malformed tenant identifier rejected with INVALID_ARGUMENT")
    assert "storage_broker_processed_messages_total" in metrics()
