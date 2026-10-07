export type AttendanceSession = {
  id: string; identity: string; accountUid: string; name: string;
  audienceType: "individual" | "church" | "presenter";
  connectedAt: string; disconnectedAt: string | null;
  specialAccessCode: string | null; privateDeveloper: boolean;
};
export type ServiceReport = {
  roomName: string; title: string; startedAt: string; endedAt: string | null;
  peakIndividuals: number; individualsAtEnd: number; currentIndividuals: number;
  sessions: AttendanceSession[];
};

export function buildServiceReport(
  service: Pick<ServiceReport, "roomName" | "title" | "startedAt" | "endedAt"> & { finalIndividualCount?: number },
  sessions: AttendanceSession[], includePrivate = false,
): ServiceReport {
  const visible = sessions.filter((session) => (includePrivate || !session.privateDeveloper) && (!service.endedAt || Date.parse(session.connectedAt) <= Date.parse(service.endedAt))).map((session) => ({ ...session,
    disconnectedAt: service.endedAt && session.disconnectedAt && Date.parse(session.disconnectedAt) >= Date.parse(service.endedAt) ? null : session.disconnectedAt,
  }));
  // Count accounts, not tabs, churches, presenters or private owner connections.
  const individuals = visible.filter((session) => session.audienceType === "individual" && !session.privateDeveloper);
  const changes = individuals.flatMap((session) => [
    { at: Date.parse(session.connectedAt), uid: session.accountUid || session.identity, delta: 1 },
    ...(session.disconnectedAt ? [{ at: Date.parse(session.disconnectedAt), uid: session.accountUid || session.identity, delta: -1 }] : []),
  ]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  const accounts = new Map<string, number>();
  let peakIndividuals = 0;
  for (const change of changes) {
    const next = (accounts.get(change.uid) ?? 0) + change.delta;
    if (next > 0) accounts.set(change.uid, next); else accounts.delete(change.uid);
    peakIndividuals = Math.max(peakIndividuals, accounts.size);
  }
  const currentIndividuals = new Set(individuals.filter((session) => !session.disconnectedAt).map((session) => session.accountUid || session.identity)).size;
  peakIndividuals = Math.max(peakIndividuals, service.finalIndividualCount ?? 0);
  return { ...service, sessions: visible.sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)), peakIndividuals,
    individualsAtEnd: service.endedAt ? service.finalIndividualCount ?? currentIndividuals : 0, currentIndividuals: service.endedAt ? 0 : currentIndividuals };
}
