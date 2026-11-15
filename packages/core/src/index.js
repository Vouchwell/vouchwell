/**
 * Vouchwell core — tamper-evident receipts for AI agent actions.
 *
 * @see https://github.com/vouchwell/vouchwell#readme
 */

export { canonicalize, canonicalBytes } from './canonical.js';
export {
  sha256,
  hashObject,
  hex,
  unhex,
  equalBytes,
  LEAF_PREFIX,
  NODE_PREFIX,
  RECEIPT_PREFIX,
  CHECKPOINT_PREFIX,
} from './hash.js';
export {
  generateIdentity,
  identityFromPem,
  identityFromPublicKey,
  publicKeyObject,
  keyIdFor,
  sign,
  verify,
} from './keys.js';
export {
  MerkleTree,
  leafHash,
  nodeHash,
  merkleRoot,
  inclusionProof,
  verifyInclusion,
  consistencyProof,
  verifyConsistency,
} from './merkle.js';
export {
  RECEIPT_VERSION,
  GENESIS_PREV,
  seal,
  openSeal,
  buildReceipt,
  receiptDigest,
  entryHash,
  signReceipt,
  verifyReceipt,
  verifyChain,
} from './receipt.js';
export {
  CHECKPOINT_VERSION,
  buildCheckpoint,
  checkpointDigest,
  signCheckpoint,
  signCheckpointWith,
  cosign,
  cosignWith,
  verifyCheckpoint,
} from './checkpoint.js';
export { ProofLog, verifyBundle, consistencyFor } from './log.js';
export { LogAppender } from './appender.js';
export { withLock, lockIsBusy } from './lock.js';
export { Policy, History, parseWindow, globMatch } from './policy.js';
export { regexProblem } from './safe-regex.js';
export { redact, hasSecrets, DEFAULT_DETECTORS } from './redact.js';
export { findUnfinished, DEFAULT_GRACE_MS } from './unfinished.js';
export { Recorder, PolicyDenied, NO_POLICY, recordTools } from './recorder.js';
export { POLICY_TEMPLATES, policyTemplate, composePolicy } from './templates.js';
export { witnessCheckpoint, WitnessRefusal } from './witness-client.js';
export { adoptLegacyEnv } from './legacy.js';

// The types a caller handles, for TypeScript and editors. JSDoc only: none of
// these exist at runtime.
/**
 * @typedef {import('./receipt.js').Receipt} Receipt
 * @typedef {import('./receipt.js').ReceiptBody} ReceiptBody
 * @typedef {import('./receipt.js').Actor} Actor
 * @typedef {import('./receipt.js').Decision} Decision
 * @typedef {import('./receipt.js').Sealed} Sealed
 * @typedef {import('./receipt.js').Keyring} Keyring
 * @typedef {import('./receipt.js').VerifyIssue} VerifyIssue
 * @typedef {import('./checkpoint.js').Checkpoint} Checkpoint
 * @typedef {import('./checkpoint.js').CheckpointBody} CheckpointBody
 * @typedef {import('./checkpoint.js').Signature} Signature
 * @typedef {import('./keys.js').Identity} Identity
 * @typedef {import('./policy.js').Outcome} Outcome
 * @typedef {import('./policy.js').PolicyDecision} PolicyDecision
 * @typedef {import('./recorder.js').RecorderOptions} RecorderOptions
 * @typedef {import('./redact.js').Detector} Detector
 * @typedef {import('./redact.js').RedactionResult} RedactionResult
 * @typedef {import('./redact.js').RedactionFinding} RedactionFinding
 * @typedef {import('./templates.js').PolicyTemplate} PolicyTemplate
 * @typedef {import('./unfinished.js').UnfinishedAction} UnfinishedAction
 */
