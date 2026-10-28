import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AssistantMessage, FauxResponseStep } from '@earendil-works/pi-ai';
import type { TurnPurpose } from '@/lib/contracts/intent';
import type { ModelRuntime } from '@/agent/providers/types';

export interface ScriptedTurnDeclaration {
  purpose: Exclude<TurnPurpose, 'undecided'>;
  operations: readonly string[];
  allowProtocolExamples?: boolean;
  workflow?: boolean;
  needsInput?: boolean;
}

/** Tests declare interpretation through the same registered tool as a live provider. */
export function turnDeclaration(declaration: ScriptedTurnDeclaration): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('describe_turn', {
    purpose: declaration.purpose,
    operations: [...declaration.operations],
    needsInput: declaration.needsInput ?? false,
    ...(declaration.allowProtocolExamples !== undefined ? { allowProtocolExamples: declaration.allowProtocolExamples } : {}),
    ...(declaration.workflow !== undefined ? { workflow: declaration.workflow } : {}),
  })], { stopReason: 'toolUse' });
}

/** Model call counts include the declaration; scripts cannot bypass runtime or gateway checks. */
export function scriptedProvider(declaration: ScriptedTurnDeclaration, steps: readonly FauxResponseStep[]): {
  provider: ModelRuntime;
  calls(): number;
} {
  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses([turnDeclaration(declaration), ...steps]);
  return { provider: { model: registration.getModel(), streamFn: models.streamSimple.bind(models) },
    calls: () => registration.state.callCount };
}
