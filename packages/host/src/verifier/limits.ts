/**
 * Cap on the AUTHORED plan artifact the verifier accepts (8 MiB). The cap
 * guards the verifier, not the author — exceeding it is an application
 * limitation, never an instruction to shorten the plan.
 */
export const PLAN_ARTIFACT_BYTE_LIMIT = 8 * 1024 * 1024;
/** Cap on the PREPARED document the verifier will accept (32 MiB). */
export const PLAN_PREPARED_BYTE_LIMIT = 32 * 1024 * 1024;
