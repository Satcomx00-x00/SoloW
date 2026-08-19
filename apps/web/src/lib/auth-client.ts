"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client (task TASK-011). No base URL is configured on purpose: the SPA and
 * its API are the same origin, so relative requests are correct in every deployment and there is
 * no build-time URL to get wrong.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
