// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title AckLedger
/// @notice Delivery guarantee for one in-flight callback: the destination emits `Ack(seq)`, the reactive contract
///         subscribes to it, and an un-acked callback is resent on a CRON tick after a full `ackTimeout`
///         (`sentAt` resets on every try). After `fastTries` tries the pace drops to one resend per `slowEvery`
///         and the caller raises an alarm, so a broken Ack path costs at most one callback per `slowEvery`.
/// @dev Newer state supersedes: `start` overwrites a pending un-acked seq. Callers that must never be superseded
///      (e.g. an attest heartbeat) should keep their own ledger. A late Ack for an older seq is ignored.
library AckLedger {
    struct Pending {
        uint64 seq;
        uint64 sentAt;
        uint8 tries; // sends so far, including the first
        bool open;
        bytes32 payloadHash;
    }

    struct Policy {
        uint64 ackTimeout; // >= 2 x p95 of the measured callback -> Ack round trip
        uint8 fastTries;
        uint64 slowEvery;
    }

    error BadPolicy();

    function validate(Policy memory p) internal pure {
        // fastTries + 1 must be reachable below the uint8 saturation point, or the one-shot alarm repeats / overflows.
        if (p.ackTimeout == 0 || p.fastTries == 0 || p.fastTries > 253 || p.slowEvery < p.ackTimeout) revert BadPolicy();
    }

    function start(Pending storage p, uint64 seq, bytes32 payloadHash, uint64 nowTs) internal {
        p.seq = seq;
        p.sentAt = nowTs;
        p.tries = 1;
        p.open = true;
        p.payloadHash = payloadHash;
    }

    /// @return matched true only for the Ack of the currently open seq.
    function ack(Pending storage p, uint64 seq) internal returns (bool matched) {
        if (p.open && p.seq == seq) {
            p.open = false;
            return true;
        }
        return false;
    }

    /// @notice Wait before the next resend: `ackTimeout` while tries <= fastTries, then `slowEvery`.
    function wait(Pending storage p, Policy memory pol) internal view returns (uint64) {
        return p.tries > pol.fastTries ? pol.slowEvery : pol.ackTimeout;
    }

    function due(Pending storage p, Policy memory pol, uint64 nowTs) internal view returns (bool) {
        return p.open && nowTs >= p.sentAt + wait(p, pol);
    }

    /// @notice Record a resend. Returns true exactly once: on the first resend past `fastTries` (raise the alarm).
    function markResent(Pending storage p, Policy memory pol, uint64 nowTs) internal returns (bool stuck) {
        p.sentAt = nowTs;
        if (p.tries < type(uint8).max) p.tries++;
        return p.tries == pol.fastTries + 1;
    }

    /// @notice Worst-case seconds from first send to the alarm when resends only happen on CRON ticks of `tick` s.
    function alarmBound(Policy memory pol, uint64 tick) internal pure returns (uint64) {
        uint64 perTry = ((pol.ackTimeout + tick - 1) / tick) * tick;
        return uint64(pol.fastTries) * perTry;
    }
}
