import { useState } from "react";
import type { OwnedSessionRecord } from "@omp-ui/core/types";
import type { ModelInfo } from "./rpc-types";
import type { PlanExecutionOptions, StagedKeyword } from "./plan-concerns";

/** The staged Execute options the hook owns: the keyword switches plus goal. */
export type StagedSwitches = Required<Pick<PlanExecutionOptions, StagedKeyword | "goal">>;

const EMPTY_SWITCHES: StagedSwitches = {
  ultrathink: false,
  orchestrate: false,
  workflowz: false,
  goal: false,
};

export function usePlanDispatchStaging(
  review: unknown,
  sessionRecord: OwnedSessionRecord | undefined,
  model: ModelInfo | null,
  thinkingLevel: string | null,
) {
  const [stagedModel, setStagedModel] = useState<ModelInfo | null>(model);
  const [stagedThinking, setStagedThinking] = useState<string | null>(thinkingLevel);
  const [stagedAdvisor, setStagedAdvisor] = useState(sessionRecord?.advisor ?? false);
  const [stagedAdvisorModel, setStagedAdvisorModel] = useState<string | null>(
    sessionRecord?.advisorModel ?? null,
  );
  const [switches, setSwitches] = useState<StagedSwitches>(EMPTY_SWITCHES);
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingAdvisorModel, setPickingAdvisorModel] = useState(false);
  const [seededFor, setSeededFor] = useState<unknown>(null);

  if (review !== seededFor) {
    setSeededFor(review);
    setStagedModel(model);
    setStagedThinking(thinkingLevel);
    setStagedAdvisor(sessionRecord?.advisor ?? false);
    setStagedAdvisorModel(sessionRecord?.advisorModel ?? null);
    setSwitches(EMPTY_SWITCHES);
    setPickingModel(false);
    setPickingAdvisorModel(false);
  }

  const setSwitch = <K extends keyof StagedSwitches>(key: K, armed: boolean): void => {
    setSwitches((current) => ({ ...current, [key]: armed }));
  };

  return {
    stagedModel,
    setStagedModel,
    stagedThinking,
    setStagedThinking,
    stagedAdvisor,
    setStagedAdvisor,
    stagedAdvisorModel,
    setStagedAdvisorModel,
    switches,
    setSwitch,
    pickingModel,
    setPickingModel,
    pickingAdvisorModel,
    setPickingAdvisorModel,
  };
}
