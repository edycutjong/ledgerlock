// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {MockCallbackProxy} from "reactive-test-lib/mock/MockCallbackProxy.sol";
import {CallbackResult} from "reactive-test-lib/interfaces/IReactiveInterfaces.sol";
import {OmniSystemMock} from "./OmniSystemMock.sol";
import {CronTopics} from "../CronTopics.sol";

/// @title OmniReactiveTest
/// @notice Foundry base for Reactive **Omni** contracts: origin event -> `react()` (from 0x8888…8888) ->
///         `requestCallbackV_1_0` -> callback through reactive-test-lib's MockCallbackProxy -> destination events fed
///         back as new logs (Ack loops), until quiescence.
/// @dev Injected callback identity: measured on Lasna -> Base Sepolia (2026-11-08, evidence/triples.csv) the proxy
///      injects the REQUESTING reactive contract's address as the first argument (Omni docs), not the deployer
///      (reactive-test-lib docs). `injectRequester` defaults to true to match the network.
abstract contract OmniReactiveTest is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint256 internal constant MAX_CYCLES = 20;

    OmniSystemMock internal sys;
    MockCallbackProxy internal proxy;
    bool internal injectRequester = true;
    address internal injectOverride; // when non-zero, injected instead (negative tests)

    mapping(address => uint256) internal chainOf;
    uint256 private _nonce;

    function setUp() public virtual {
        vm.etch(SYSTEM_ADDR, address(new OmniSystemMock()).code);
        sys = OmniSystemMock(payable(SYSTEM_ADDR));
        proxy = new MockCallbackProxy();
    }

    /// @notice Logs emitted by `emitter` are tagged with `chainId` (default: block.chainid).
    function onChain(address emitter, uint256 chainId) internal {
        chainOf[emitter] = chainId;
    }

    function _chain(address emitter) internal view returns (uint256) {
        uint256 c = chainOf[emitter];
        return c == 0 ? block.chainid : c;
    }

    // ---------------------------------------------------------------- log plumbing

    function _toRecords(Vm.Log[] memory logs) internal returns (IReactive.LogRecord[] memory out) {
        out = new IReactive.LogRecord[](logs.length);
        for (uint256 i; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            out[i] = IReactive.LogRecord({
                chainId: _chain(l.emitter),
                contractAddress: l.emitter,
                topic0: l.topics.length > 0 ? uint256(l.topics[0]) : 0,
                topic1: l.topics.length > 1 ? uint256(l.topics[1]) : 0,
                topic2: l.topics.length > 2 ? uint256(l.topics[2]) : 0,
                topic3: l.topics.length > 3 ? uint256(l.topics[3]) : 0,
                data: l.data,
                blockNumber: block.number,
                opCode: l.topics.length, // docs: opCode = number of topics (LOG3 -> 3)
                blockHash: uint256(blockhash(block.number)),
                txHash: uint256(keccak256(abi.encode("tx", ++_nonce))),
                logIndex: i
            });
        }
    }

    /// @notice Deliver one log to every matching subscriber as the system contract. Returns how many reacted.
    function deliver(IReactive.LogRecord memory log) internal returns (uint256 n) {
        address[] memory subs = sys.matching(log.chainId, log.contractAddress, log.topic0, log.topic1, log.topic2, log.topic3);
        for (uint256 i; i < subs.length; i++) {
            vm.prank(SYSTEM_ADDR);
            IReactive(payable(subs[i])).react(log);
        }
        return subs.length;
    }

    /// @notice Execute queued callback requests through the mock proxy; returns results and the logs they emitted.
    function runCallbacks() internal returns (CallbackResult[] memory results, IReactive.LogRecord[] memory emitted) {
        OmniSystemMock.Request[] memory reqs = sys.takeRequests();
        results = new CallbackResult[](reqs.length);
        vm.recordLogs();
        vm.getRecordedLogs(); // drop reactive-side logs: only destination logs feed back
        for (uint256 i; i < reqs.length; i++) {
            address injected = injectOverride != address(0) ? injectOverride : (injectRequester ? reqs[i].requester : address(this));
            (bool ok, bytes memory ret) = proxy.executeCallback(reqs[i].recipient, reqs[i].payload, reqs[i].gasLimit, injected);
            results[i] = CallbackResult(reqs[i].chainId, reqs[i].recipient, reqs[i].gasLimit, reqs[i].payload, ok, ret);
        }
        emitted = _toRecords(vm.getRecordedLogs());
    }

    // ---------------------------------------------------------------- high-level steps

    /// @notice Call `target` as `from`, deliver its logs, run the resulting callbacks once (no feedback).
    function step(address from, address target, bytes memory data) internal returns (CallbackResult[] memory results) {
        vm.recordLogs();
        vm.prank(from);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) _bubble(ret);
        IReactive.LogRecord[] memory recs = _toRecords(vm.getRecordedLogs());
        for (uint256 i; i < recs.length; i++) {
            deliver(recs[i]);
        }
        (results,) = runCallbacks();
    }

    /// @notice Like `step`, but keeps feeding callback-emitted logs back until no callback is requested.
    function cycle(address from, address target, bytes memory data) internal returns (CallbackResult[] memory all) {
        vm.recordLogs();
        vm.prank(from);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) _bubble(ret);
        all = _drain(_toRecords(vm.getRecordedLogs()));
    }

    /// @notice Deliver a CRON tick (real topic, legacy emitter, empty data as observed on Lasna) and settle callbacks.
    function cron(uint256 cronTopic) internal returns (CallbackResult[] memory all) {
        IReactive.LogRecord[] memory recs = new IReactive.LogRecord[](1);
        recs[0] = IReactive.LogRecord({
            chainId: block.chainid,
            contractAddress: CronTopics.LEGACY_SYSTEM_ADDR,
            topic0: cronTopic,
            topic1: 0,
            topic2: 0,
            topic3: 0,
            data: "",
            blockNumber: block.number,
            opCode: 1, // topic0 only
            blockHash: 0,
            txHash: uint256(keccak256(abi.encode("cron", ++_nonce))),
            logIndex: 0
        });
        all = _drain(recs);
    }

    function _drain(IReactive.LogRecord[] memory recs) internal returns (CallbackResult[] memory all) {
        all = new CallbackResult[](0);
        bool quiet;
        for (uint256 it; it < MAX_CYCLES; it++) {
            for (uint256 i; i < recs.length; i++) {
                deliver(recs[i]);
            }
            CallbackResult[] memory batch;
            (batch, recs) = runCallbacks();
            if (batch.length == 0) {
                quiet = true;
                break;
            }
            all = _concat(all, batch);
        }
        // Never return with feedback records undelivered: a callback loop that does not settle is a finding.
        require(quiet, "OmniReactiveTest: no quiescence within MAX_CYCLES");
    }

    function _concat(CallbackResult[] memory a, CallbackResult[] memory b) internal pure returns (CallbackResult[] memory c) {
        c = new CallbackResult[](a.length + b.length);
        for (uint256 i; i < a.length; i++) c[i] = a[i];
        for (uint256 i; i < b.length; i++) c[a.length + i] = b[i];
    }

    function _bubble(bytes memory ret) internal pure {
        assembly {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    // ---------------------------------------------------------------- assertions

    function assertCallbacks(CallbackResult[] memory r, uint256 n) internal pure {
        assertEq(r.length, n, "callback count");
    }

    function assertAllSucceeded(CallbackResult[] memory r) internal pure {
        for (uint256 i; i < r.length; i++) {
            assertTrue(r[i].success, "callback reverted");
        }
    }
}
