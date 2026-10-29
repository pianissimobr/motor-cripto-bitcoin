export type ReadinessCheckResult = {
  ok: boolean;
  detail?: string;
  tipHeight?: number;
};

export type ReadinessCheck = {
  name: string;
  run: () => Promise<ReadinessCheckResult>;
};

export type Readiness = {
  checks: ReadinessCheck[];
};
