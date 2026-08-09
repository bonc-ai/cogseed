/** Host-owned release identity for the only reimbursement component Mate may execute. */
export const TRUSTED_EXPENSE_COMPONENT_VERSION = 'v1.3.0-rc1' as const;

export interface TrustedExpenseComponentFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface TrustedPythonDistribution {
  readonly distribution: string;
  readonly version: string;
  readonly distInfoDirectory: string;
  readonly recordSha256: string;
}

export interface TrustedExpensePlatformArtifacts {
  readonly pythonArchive: TrustedPythonArchive;
  readonly pythonDistributions: readonly TrustedPythonDistribution[];
}

export interface TrustedPythonArchive {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly manifestExecutable: string;
}

/**
 * Complete transitive source closure reachable from stdio_bridge.py. Package
 * initializers are included because Python executes them before submodules.
 */
export const TRUSTED_EXPENSE_COMPONENT_FILES: readonly TrustedExpenseComponentFile[] = Object.freeze([
  Object.freeze({ path: 'env_loader.py', bytes: 3_679, sha256: 'c94e5423abf854dc4fa05d75a294473be1b8403290f016c994f523df53c3bd66' }),
  Object.freeze({ path: 'expense_reimbursement/__init__.py', bytes: 70_292, sha256: '8cfa7b3429446b2b8405ff9aa0ca2515a8c6ff3641e778ab6765f7648a2dc7ff' }),
  Object.freeze({ path: 'expense_reimbursement/agents/audit_hook.py', bytes: 8_001, sha256: '5f8ad9bd897d1e83910c2b54c711104deed4566a1ea69d693bea234eb14ae7d9' }),
  Object.freeze({ path: 'expense_reimbursement/agents/base.py', bytes: 9_549, sha256: 'd37e3ebfb5e296c4fd16ceea79a1158926ae40d0ea578986c6212b8ca0d8adc1' }),
  Object.freeze({ path: 'expense_reimbursement/agents/compliance_agent.py', bytes: 23_123, sha256: '8aaaf054e1d0d48fa876881ee82bd58ce46fe0c293dc2ae5320433749e2f29a2' }),
  Object.freeze({ path: 'expense_reimbursement/agents/ocr_agent.py', bytes: 16_511, sha256: '1a556928d658bba15b0fe367a8e7c9b228b23eb0bd16135ec2d9d3fd69e9712b' }),
  Object.freeze({ path: 'expense_reimbursement/agents/project_invoice_for_prompt.py', bytes: 7_244, sha256: '81ff1aeb62b0368909166f3e181e994478e9b9371b8aa0aa590bb5436a0a5b0b' }),
  Object.freeze({ path: 'expense_reimbursement/agents/sanitize_ocr_field.py', bytes: 6_503, sha256: '390de50f9a9fedbc9e1be8fc21ddb4737ec193f7d139eddf34dc954f6d6e28fd' }),
  Object.freeze({ path: 'expense_reimbursement/agents/validation_agent.py', bytes: 25_592, sha256: '210ac5fdac0251d7239e3baa17a505261f8d0bbbe598e6f55d3e44ba3dd49db6' }),
  Object.freeze({ path: 'expense_reimbursement/core/anomaly.py', bytes: 20_518, sha256: 'd92a33ac9793a776fcfd35bdfb42449f55494f5531ac6049883626ddef01d743' }),
  Object.freeze({ path: 'expense_reimbursement/core/approval.py', bytes: 19_970, sha256: 'c50dcf01cc4c6c92225bad4521c01079709a31805aa062ecc76d73284f7e0afe' }),
  Object.freeze({ path: 'expense_reimbursement/core/memory.py', bytes: 10_473, sha256: '98503c8bcf8e6f3938c04cb54f70e2e81fe8216d9ec1d326b6d2ad6cdd31e2ad' }),
  Object.freeze({ path: 'expense_reimbursement/core/models.py', bytes: 22_305, sha256: 'ea57e6d0c1fb6ee11de106ec27f3dbf4980c3e41e9a4d74faedf4ff15f719e93' }),
  Object.freeze({ path: 'expense_reimbursement/core/pipeline.py', bytes: 12_821, sha256: '3d270fcdd68a0e4490049967fc06544ee44d6f646923d8a23f34f56db50a32d5' }),
  Object.freeze({ path: 'expense_reimbursement/core/private_json.py', bytes: 1_404, sha256: '193f389da6a945b50232ce9df5dc21129e91557cc3f061abdf76dc8c16315ddb' }),
  Object.freeze({ path: 'expense_reimbursement/core/report_schema.py', bytes: 20_424, sha256: '1dd0d7ffdd2897863483e49e8c5e143433daf756a805b7b7ed8ecf4c73a0abe5' }),
  Object.freeze({ path: 'expense_reimbursement/core/session.py', bytes: 4_864, sha256: '2585935610f7bacdee1df48de03aa0c016c37b63a7d82b6095dacfeade23f71c' }),
  Object.freeze({ path: 'expense_reimbursement/core/verification.py', bytes: 39_493, sha256: 'f7a94a145003f91442e8296eb5b8f7bb8d42d0b418156f03a92998341565cbcd' }),
  Object.freeze({ path: 'expense_reimbursement/core/workflow.py', bytes: 19_142, sha256: '0b9190e1d371e5b35c89f23ef1c18838f62dd355a154c9f4d1f8300991beef3b' }),
  Object.freeze({ path: 'expense_reimbursement/database/repository.py', bytes: 68_723, sha256: 'c5cdb1daa88638cc25195827d1a5db50d046118487011174865af0491e813a40' }),
  Object.freeze({ path: 'expense_reimbursement/guardrails/__init__.py', bytes: 451, sha256: 'f180f5d15b341e424fdc70e1496ad67d56b844fa84a1989e68114302cd12fed4' }),
  Object.freeze({ path: 'expense_reimbursement/guardrails/deterministic.py', bytes: 7_434, sha256: 'd5f8950d32518edaa4de896ba409a24d0214c5e8ca6495f1a2a1e36a81464962' }),
  Object.freeze({ path: 'expense_reimbursement/guardrails/human_review.py', bytes: 23_980, sha256: '5132ec6956ab46a659e840d2dd76536bc440e192f8f4555ca3415cce2ebeccfa' }),
  Object.freeze({ path: 'expense_reimbursement/integrations/feishu.py', bytes: 19_792, sha256: 'dbf211e3f01f8585585a095f4b2da4ecaed5d8b331a2c05e5dc052653b56a6d8' }),
  Object.freeze({ path: 'expense_reimbursement/integrations/importer.py', bytes: 26_011, sha256: '91760fd8ceb9f89049373d09e650e8f0d38d79c27cf07543fdb13dd5499c19cb' }),
  Object.freeze({ path: 'expense_reimbursement/integrations/llm_client.py', bytes: 9_774, sha256: 'ad465361da0d75185d9c4a6a632ec25feb9f9103781a49c300c1afd105ec33c6' }),
  Object.freeze({ path: 'expense_reimbursement/task_agent/__init__.py', bytes: 53, sha256: 'f38318b581ed026e10f7d9d8dc22c0539f9e4a2b53c86cd4ef40873840987a4e' }),
  Object.freeze({ path: 'expense_reimbursement/task_agent/stdio_bridge.py', bytes: 112_606, sha256: '2d0fc53f6b3ef2225a8719b5e3695757f683d92765f9787e417afad273748801' }),
  Object.freeze({ path: 'ontology/__init__.py', bytes: 364, sha256: '912db1c6fb6e89ecf43b27bf88b19d20b19c773fded610b5a9cacc61f36dcac7' }),
  Object.freeze({ path: 'ontology/abox.py', bytes: 15_750, sha256: '18148d27b7054f9eb49898da79064223b16823d91131532a06bc8fe42c8654c5' }),
  Object.freeze({ path: 'ontology/context.py', bytes: 4_763, sha256: '7ee022c79a2588a2de8e281d55734c7432db1dbd57d13be2a8cf40bdc2e169d0' }),
  Object.freeze({ path: 'ontology/rbox.py', bytes: 11_427, sha256: '5e398f76e7519e03cafb627f0979e661d0520e4a5edceaf30ed4e5c9c267e391' }),
  Object.freeze({ path: 'ontology/tbox.py', bytes: 16_992, sha256: 'e5dae34e0fccaa1a7bddb619f5315c60798e95ef2c5b8d07f5af5df4677978ca' }),
  Object.freeze({ path: 'config/policy.json', bytes: 5_882, sha256: 'dc400eefabc250b3789561f33323474701dc3f15c1e5dd7dfe15f289d9c9b175' }),
]);

export const TRUSTED_EXPENSE_BRIDGE_PATH = 'expense_reimbursement/task_agent/stdio_bridge.py' as const;

const DARWIN_ARM64_DISTRIBUTIONS: readonly TrustedPythonDistribution[] = Object.freeze([
  Object.freeze({ distribution: 'pydantic', version: '2.13.4', distInfoDirectory: 'pydantic-2.13.4.dist-info', recordSha256: 'ff8205cd76c28ab5d20f17483c3c0d12083d16ffc3d18c813a9087e331f51134' }),
  Object.freeze({ distribution: 'pydantic-core', version: '2.46.4', distInfoDirectory: 'pydantic_core-2.46.4.dist-info', recordSha256: '3096b1a0fd6b4fe0b0420397e74cadeaadd97d4ca7a41e92a95c1f2bfad2d9e6' }),
  Object.freeze({ distribution: 'typing-extensions', version: '4.16.0', distInfoDirectory: 'typing_extensions-4.16.0.dist-info', recordSha256: '78f74ed46a377d6e1debed78b3e994ff9cfe02a529d393d7c8ab80989bd25079' }),
  Object.freeze({ distribution: 'typing-inspection', version: '0.4.2', distInfoDirectory: 'typing_inspection-0.4.2.dist-info', recordSha256: '4319c4d16400fc6d90b044bac966ce65f5202f2e071da5566d7e67cd96b5127f' }),
  Object.freeze({ distribution: 'annotated-types', version: '0.8.0', distInfoDirectory: 'annotated_types-0.8.0.dist-info', recordSha256: '906944aac6c7f85a4ebedde03e8fc1fcc2e4b99ec400b60bc088c9ae321d2c82' }),
  Object.freeze({ distribution: 'annotated-doc', version: '0.0.5', distInfoDirectory: 'annotated_doc-0.0.5.dist-info', recordSha256: 'fcf4349c991a1d7052ef1648bc52ac31cc9322856d65512cbd7c186844054185' }),
]);

/** Native wheels are target-specific. Unreviewed targets deliberately fail closed. */
export const TRUSTED_EXPENSE_PLATFORM_ARTIFACTS: Readonly<Record<string, TrustedExpensePlatformArtifacts>> = Object.freeze({
  'darwin-arm64': Object.freeze({
    pythonArchive: Object.freeze({
      name: 'cpython-3.12.13+20260610-aarch64-apple-darwin-install_only_stripped.tar.gz',
      bytes: 25_000_199,
      sha256: 'f0a7fa7decc75df2b1a789329a44f657c4a15c0a683f197ce46a5cb621bc6ef4',
      manifestExecutable: 'python/bin/python3',
    }),
    pythonDistributions: DARWIN_ARM64_DISTRIBUTIONS,
  }),
});
