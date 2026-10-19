import { useState, type Dispatch, type SetStateAction } from "react";
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

/** Everything the staging hook owns: seed captures, staged Execute values, pickers. */
export interface PlanDispatchStaging {
  /** Model the session had when the current review opened ("clear tier" restores it). */
  seededModel: ModelInfo | null;
  /** Thinking level the session had when the current review opened. */
  seededThinking: string | null;
  stagedModel: ModelInfo | null;
  setStagedModel: Dispatch<SetStateAction<ModelInfo | null>>;
  stagedThinking: string | null;
  setStagedThinking: Dispatch<SetStateAction<string | null>>;
  stagedAdvisor: boolean;
  setStagedAdvisor: Dispatch<SetStateAction<boolean>>;
  stagedAdvisorModel: string | null;
  setStagedAdvisorModel: Dispatch<SetStateAction<string | null>>;
  switches: StagedSwitches;
  setSwitch: <K extends keyof StagedSwitches>(key: K, armed: boolean) => void;
  pickingModel: boolean;
  setPickingModel: Dispatch<SetStateAction<boolean>>;
  pickingAdvisorModel: boolean;
  setPickingAdvisorModel: Dispatch<SetStateAction<boolean>>;
}

export function usePlanDispatchStaging(
  review: unknown,
  sessionRecord: OwnedSessionRecord | undefined,
  model: ModelInfo | null,
  thinkingLevel: string | null,
): PlanDispatchStaging {
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
  const [seededModel, setSeededModel] = useState<ModelInfo | null>(model);
  const [seededThinking, setSeededThinking] = useState<string | null>(thinkingLevel);

  if (review !== seededFor) {
    setSeededFor(review);
    setStagedModel(model);
    setStagedThinking(thinkingLevel);
    setSeededModel(model);
    setSeededThinking(thinkingLevel);
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
    seededModel,
    seededThinking,
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
