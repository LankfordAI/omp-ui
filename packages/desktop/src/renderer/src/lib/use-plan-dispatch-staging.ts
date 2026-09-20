import { useState } from "react";
import type { OwnedSessionRecord } from "@omp-ui/core/types";
import type { MagicKeyword } from "./magic-keywords";
import type { ModelInfo } from "./rpc-types";

const EMPTY_KEYWORDS: Record<MagicKeyword, boolean> = {
  ultrathink: false,
  orchestrate: false,
  workflowz: false,
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
  const [keywords, setKeywords] = useState<Record<MagicKeyword, boolean>>(EMPTY_KEYWORDS);
  const [pickingModel, setPickingModel] = useState(false);
  const [pickingAdvisorModel, setPickingAdvisorModel] = useState(false);
  const [seededFor, setSeededFor] = useState<unknown>(null);

  if (review !== seededFor) {
    setSeededFor(review);
    setStagedModel(model);
    setStagedThinking(thinkingLevel);
    setStagedAdvisor(sessionRecord?.advisor ?? false);
    setStagedAdvisorModel(sessionRecord?.advisorModel ?? null);
    setKeywords(EMPTY_KEYWORDS);
    setPickingModel(false);
    setPickingAdvisorModel(false);
  }

  const setKeyword = (keyword: MagicKeyword, armed: boolean): void => {
    setKeywords((current) => ({ ...current, [keyword]: armed }));
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
    keywords,
    setKeyword,
    pickingModel,
    setPickingModel,
    pickingAdvisorModel,
    setPickingAdvisorModel,
  };
}
