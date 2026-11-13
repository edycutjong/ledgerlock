// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IReactive} from "reactive-lib-omni/interfaces/IReactive.sol";
import {AbsenceWatch} from "../src/AbsenceWatch.sol";
import {AckLedger} from "../src/AckLedger.sol";
import {CallbackFailureWatch} from "../src/CallbackFailureWatch.sol";

contract AbsenceWatchTest is Test {
    using AbsenceWatch for AbsenceWatch.Watch;

    AbsenceWatch.Watch w;

    function test_unarmed_is_never_stale() public {
        w.init(100);
        assertFalse(w.isStale(type(uint64).max - 1000));
    }

    function test_stale_boundary() public {
        w.init(100);
        w.arm(1000);
        assertFalse(w.isStale(1100), "exactly maxGap is not stale");
        assertTrue(w.isStale(1101));
        assertEq(w.deadline(), 1100);
    }

    function test_arm_resets_last_seen() public {
        w.init(100);
        w.seen(10);
        w.arm(5000); // armed late: not instantly stale
        assertFalse(w.isStale(5050));
    }

    function test_zero_gap_rejected() public {
        vm.expectRevert(AbsenceWatch.ZeroGap.selector);
        this.initZero();
    }

    function initZero() external {
        w.init(0);
    }

    function testFuzz_seen_is_monotonic(uint64 a, uint64 b) public {
        w.init(1);
        w.seen(a);
        w.seen(b);
        assertEq(w.lastAt, a > b ? a : b);
    }

    function test_disarm_and_age() public {
        w.init(10);
        w.arm(100);
        assertEq(w.age(130), 30);
        assertEq(w.age(50), 0);
        w.disarm();
        assertFalse(w.isStale(1000));
    }
}

contract AckLedgerTest is Test {
    using AckLedger for AckLedger.Pending;

    AckLedger.Pending p;
    AckLedger.Policy pol = AckLedger.Policy({ackTimeout: 30, fastTries: 3, slowEvery: 3600});

    function test_resend_schedule_and_single_alarm() public {
        p.start(1, keccak256("x"), 0);
        assertFalse(p.due(pol, 29), "no resend before a full ackTimeout");
        assertTrue(p.due(pol, 30));
        assertFalse(p.markResent(pol, 30)); // try 2
        assertFalse(p.due(pol, 59));
        assertFalse(p.markResent(pol, 60)); // try 3
        assertTrue(p.due(pol, 90));
        assertTrue(p.markResent(pol, 90), "alarm on the first resend past fastTries"); // try 4
        assertFalse(p.due(pol, 120), "slow pace after the alarm");
        assertTrue(p.due(pol, 90 + 3600));
        assertFalse(p.markResent(pol, 3690), "alarm fires once");
    }

    function test_ack_closes_only_current_seq() public {
        p.start(1, 0, 0);
        p.start(2, 0, 5); // newer state supersedes
        assertFalse(p.ack(1), "late Ack for a superseded seq is ignored");
        assertTrue(p.open);
        assertTrue(p.ack(2));
        assertFalse(p.due(pol, 1e9));
        assertFalse(p.ack(2), "double Ack is a no-op");
    }

    function test_alarm_bound_on_cron_ticks() public view {
        // ackTimeout 30 s, Cron10 measured at 10-11 s on Lasna: each try waits ceil(30/11)*11 = 33 s
        assertEq(AckLedger.alarmBound(pol, 11), 99);
        assertEq(AckLedger.alarmBound(pol, 10), 90);
    }

    function test_policy_validation() public {
        AckLedger.validate(pol);
        vm.expectRevert(AckLedger.BadPolicy.selector);
        this.validateBad(AckLedger.Policy({ackTimeout: 30, fastTries: 3, slowEvery: 10}));
        vm.expectRevert(AckLedger.BadPolicy.selector); // the one-shot alarm needs fastTries + 1 below uint8 saturation
        this.validateBad(AckLedger.Policy({ackTimeout: 30, fastTries: 254, slowEvery: 60}));
    }

    function validateBad(AckLedger.Policy memory b) external pure {
        AckLedger.validate(b);
    }

    function testFuzz_tries_saturate(uint16 n) public {
        p.start(1, 0, 0);
        for (uint256 i; i < uint256(n) % 600; i++) {
            p.markResent(pol, uint64(i));
        }
        assertLe(p.tries, type(uint8).max);
    }
}

contract FailureHarness {
    function isFailure(IReactive.LogRecord calldata l, uint256 c, address proxy, address target) external pure returns (bool) {
        return CallbackFailureWatch.isFailure(l, c, proxy, target);
    }

    function decode(IReactive.LogRecord calldata l) external pure returns (bytes4 sel, uint256 rvm, uint256 seq) {
        bytes memory p = CallbackFailureWatch.payload(l);
        return (CallbackFailureWatch.selectorOf(p), CallbackFailureWatch.argWord(p, 0), CallbackFailureWatch.argWord(p, 1));
    }
}

contract CallbackFailureWatchTest is Test {
    // Real log: Base Sepolia tx 0x8e4b4956b695caae98540ae2896090ccdfe209ea8976fde7e8bdea595658a55c
    address constant PROXY = 0x476F44b11F5C942c58f4c8E3d0300E5710743585;
    address constant TARGET = 0x90721E018E2246a6555755D63418686a1A04FD9f;
    address constant RC = 0xe4A0Bf147c9C8390ea4e7C915e7801606c171909;
    bytes constant DATA =
        hex"00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000084489f3c88000000000000000000000000e4a0bf147c9c8390ea4e7c915e7801606c17190900000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000014a34e224940a552f813a2b9f67954859c4b05a3e61be864ae383edb2d2a3297eedca00000000000000000000000000000000000000000000000000000000";

    function _log() internal pure returns (IReactive.LogRecord memory l) {
        l.chainId = 84532;
        l.contractAddress = PROXY;
        l.topic0 = CallbackFailureWatch.TOPIC;
        l.topic1 = uint256(uint160(TARGET));
        l.data = DATA;
    }

    function test_topic_is_signature_hash() public pure {
        assertEq(CallbackFailureWatch.TOPIC, uint256(keccak256("CallbackFailure(address,bytes)")));
    }

    function test_decodes_real_base_sepolia_failure() public {
        FailureHarness h = new FailureHarness();
        assertTrue(h.isFailure(_log(), 84532, PROXY, TARGET));
        assertFalse(h.isFailure(_log(), 84532, PROXY, address(0xBEEF)), "other target");
        assertFalse(h.isFailure(_log(), 8453, PROXY, TARGET), "other chain");
        (bytes4 sel, uint256 rvm, uint256 seq) = h.decode(_log());
        assertEq(sel, bytes4(keccak256("ping(address,uint256,uint256,uint256)")));
        assertEq(address(uint160(rvm)), RC, "payload already carries the injected RC address");
        assertEq(seq, 5);
    }
}
