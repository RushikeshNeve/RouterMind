import type { GatewayRequestContext } from "@routemind/core";

export interface Principal {
  readonly id: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
}

export interface CredentialEnvelope {
  readonly scheme: "api-key" | "bearer";
  readonly value: string;
}

export interface Authenticator {
  authenticate(credential: CredentialEnvelope): Promise<Principal>;
}

export interface Authorizer {
  authorize(principal: Principal, action: string, context: GatewayRequestContext): Promise<boolean>;
}
