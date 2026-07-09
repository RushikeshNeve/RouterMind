import type { RoutingCandidateModel } from "@routemind/routing";
import type { CircuitBreakerService } from "./circuit-breaker-service.js";

export class ProviderFallbackService {
  constructor(private readonly circuitBreakerService: CircuitBreakerService) {}

  async buildFallbackOrder(input: {
    readonly primaryProvider: string;
    readonly primaryModel: string;
    readonly candidates: readonly RoutingCandidateModel[];
  }): Promise<{
    readonly candidates: readonly RoutingCandidateModel[];
    readonly circuitBreakerTriggered: boolean;
  }> {
    const ordered = [
      ...input.candidates.filter(
        (candidate) =>
          candidate.provider === input.primaryProvider && candidate.model === input.primaryModel,
      ),
      ...input.candidates.filter(
        (candidate) =>
          candidate.provider !== input.primaryProvider || candidate.model !== input.primaryModel,
      ),
    ];
    const deduped = ordered.filter(
      (candidate, index, array) =>
        array.findIndex(
          (item) => item.provider === candidate.provider && item.model === candidate.model,
        ) === index,
    );
    const availability = await Promise.all(
      deduped.map(async (candidate) => ({
        candidate,
        canAttempt: await this.circuitBreakerService.canAttempt(
          candidate.provider,
          candidate.model,
        ),
      })),
    );

    return {
      candidates: availability.filter((entry) => entry.canAttempt).map((entry) => entry.candidate),
      circuitBreakerTriggered: availability.some((entry) => !entry.canAttempt),
    };
  }
}
