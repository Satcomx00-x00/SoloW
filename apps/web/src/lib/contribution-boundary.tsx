"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The blast radius of one contribution (issue #3, F19 NFR-2).
 *
 * The registry already treats a `when` predicate that throws as "not visible", because #93 will
 * let third-party code supply them. A contributed *component* is the same code with more room to
 * fail — a plugin dereferencing query data that has not arrived is the ordinary case — and
 * without a boundary it takes the surface, the shell and the route down with it. React has one
 * mechanism for this and it is a class, which is the only reason this file has one.
 *
 * A failed contribution renders nothing at all rather than an apology in the middle of a status
 * bar: the promise is that a broken item costs its own slot, and a placeholder costs the slot
 * and the user's attention. There is deliberately no retry — a component that threw once on this
 * context will throw again, and a boundary that resets itself renders the failure on a loop.
 */
interface ContributionBoundaryProps {
  /** The contribution's id, so the console names what failed rather than a stack in the shell. */
  readonly contributionId: string;
  readonly children: ReactNode;
}

interface ContributionBoundaryState {
  readonly failed: boolean;
}

export class ContributionBoundary extends Component<
  ContributionBoundaryProps,
  ContributionBoundaryState
> {
  override state: ContributionBoundaryState = { failed: false };

  static getDerivedStateFromError(): ContributionBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[contributions] "${this.props.contributionId}" threw while rendering and was dropped`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
