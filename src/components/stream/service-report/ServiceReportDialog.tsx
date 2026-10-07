"use client";

import { useEffect, useRef, useState } from "react";
import type { AttendanceSession, ServiceReport } from "../../../lib/stream/service-report";
import "./service-report.css";

const time = (value: string) => new Date(value).toLocaleString();
const minutes = (milliseconds: number) => `${(Math.max(0, milliseconds) / 60_000).toFixed(1)} min`;

function Visits({ sessions, report }: { sessions: AttendanceSession[]; report: ServiceReport }) {
  const groups = new Map<string, AttendanceSession[]>();
  for (const session of sessions) {
    const key = session.accountUid || session.identity;
    groups.set(key, [...(groups.get(key) || []), session]);
  }
  return groups.size ? Array.from(groups, ([uid, visits]) => {
    const sorted = [...visits].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
    const end = Date.parse(report.endedAt || new Date().toISOString());
    // Merge overlapping tabs so the same account's attendance is never counted twice.
    const intervals: [number, number][] = [];
    for (const visit of sorted) {
      const start = Date.parse(visit.connectedAt);
      const stop = Math.min(end, Date.parse(visit.disconnectedAt || report.endedAt || new Date().toISOString()));
      const previous = intervals.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], stop);
      else intervals.push([start, stop]);
    }
    const total = intervals.reduce((sum, [start, stop]) => sum + Math.max(0, stop - start), 0);
    return <article className="service-report-person" key={uid}>
      <h4>{sorted[0].name}</h4>
      <p>First joined {minutes(Date.parse(sorted[0].connectedAt) - Date.parse(report.startedAt))} after service start · Total attendance: <strong>{minutes(total)}</strong></p>
      <div className="service-report-table-wrap"><table><thead><tr><th>Connected</th><th>Disconnected</th><th>Time attending</th><th>Access</th></tr></thead><tbody>
        {sorted.map((visit) => <tr key={visit.id}><td>{time(visit.connectedAt)}</td><td>{visit.disconnectedAt ? time(visit.disconnectedAt) : report.endedAt ? `At service end (${time(report.endedAt)})` : "Still connected"}</td><td>{minutes(Math.min(end, Date.parse(visit.disconnectedAt || report.endedAt || new Date().toISOString())) - Date.parse(visit.connectedAt))}</td><td>{visit.specialAccessCode || "Regular"}</td></tr>)}
      </tbody></table></div>
      {intervals.slice(1).map(([start], index) => <p key={start}>Away for {minutes(start - intervals[index][1])} before returning at {time(new Date(start).toISOString())}.</p>)}
    </article>;
  }) : <p>No connections recorded in this group.</p>;
}

export default function ServiceReportDialog({ roomName, onClose }: { roomName: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [report, setReport] = useState<ServiceReport | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [pictures, setPictures] = useState<string[]>([]);
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    void fetch(`/api/stream/attendance?roomName=${encodeURIComponent(roomName)}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const result = await response.json();
      if (!response.ok || !result.report) throw new Error("The service report is not ready. Please retry shortly.");
      setReport(result.report);
      setError("");
    }).catch(() => { if (!controller.signal.aborted) setError("The service report could not be loaded. Please retry."); });
    return () => controller.abort();
  }, [roomName, retry]);
  return <dialog ref={dialog} className="service-report-dialog" onCancel={onClose}>
    <header><div><span>SERVICE ATTENDANCE</span><h2>{report?.title || "Service report"}</h2></div><button type="button" onClick={onClose} aria-label="Close service report">Close</button></header>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></p> : !report ? <p>Loading attendance…</p> : null}
    {report ? <>
      <div className="service-report-export"><button type="button" onClick={() => {
        const details = dialog.current?.querySelector("details");
        const wasOpen = details?.open;
        if (details) details.open = true;
        window.print();
        if (details) details.open = !!wasOpen;
      }}>Save as PDF</button><button type="button" onClick={() => {
        const lines = ["ZoneStream — Service attendance", report.title, `Started: ${time(report.startedAt)}`, `Ended: ${report.endedAt ? time(report.endedAt) : "Still running"}`, `Peak individuals: ${report.peakIndividuals} | Individuals at end: ${report.individualsAtEnd}`, ""];
        const groups = new Map<string, AttendanceSession[]>();
        for (const session of report.sessions) {
          const key = `${session.audienceType}:${session.accountUid}`;
          groups.set(key, [...(groups.get(key) || []), session]);
        }
        for (const visits of groups.values()) {
          lines.push(`${visits[0].audienceType.toUpperCase()} — ${visits[0].name}`);
          const intervals: [number, number][] = [];
          const ended = Date.parse(report.endedAt || new Date().toISOString());
          for (const visit of visits) {
            const start = Date.parse(visit.connectedAt), stop = Math.min(ended, Date.parse(visit.disconnectedAt || report.endedAt || new Date().toISOString()));
            const previous = intervals.at(-1);
            if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], stop); else intervals.push([start, stop]);
          }
          lines.push(`First joined ${minutes(Date.parse(visits[0].connectedAt) - Date.parse(report.startedAt))} after start | Total attendance: ${minutes(intervals.reduce((total, [start, stop]) => total + stop - start, 0))}`);
          for (const visit of visits) lines.push(`In: ${time(visit.connectedAt)} | Out: ${visit.disconnectedAt ? time(visit.disconnectedAt) : `At service end (${report.endedAt ? time(report.endedAt) : "still active"})`} | Access: ${visit.specialAccessCode || "Regular"}`);
          intervals.slice(1).forEach(([start], index) => lines.push(`Away: ${minutes(start - intervals[index][1])} | Returned: ${time(new Date(start).toISOString())}`));
          lines.push("");
        }
        const pages: string[] = [];
        for (let index = 0; index < lines.length; index += 38) {
          const canvas = document.createElement("canvas"); canvas.width = 1500; canvas.height = 1800;
          const context = canvas.getContext("2d"); if (!context) return;
          context.fillStyle = "#15151d"; context.fillRect(0, 0, 1500, 1800);
          context.fillStyle = "#f5f5fa"; context.font = "22px Arial";
          lines.slice(index, index + 38).forEach((line, row) => context.fillText(line, 50, 75 + row * 42, 1400));
          context.fillStyle = "#ff9966"; context.fillText(`ZoneStream · Page ${pages.length + 1}`, 50, 1740);
          pages.push(canvas.toDataURL("image/png"));
        }
        setPictures(pages);
      }}>Download picture</button><small>For PDF, choose “Save as PDF” in the print window.</small></div>
      {pictures.length ? <div className="service-report-export">{pictures.map((picture, index) => <a key={index} href={picture} download={`${roomName}-attendance-${index + 1}.png`}>Download picture {index + 1}</a>)}</div> : null}
      <p>Started: {time(report.startedAt)} · Ended: {report.endedAt ? time(report.endedAt) : "Service is still running"}</p>
      <div className="service-report-totals"><p><strong>{report.peakIndividuals}</strong> Peak individuals</p><p><strong>{report.individualsAtEnd}</strong> Individuals at service end</p><p><strong>{new Set(report.sessions.filter((s) => s.audienceType === "church").map((s) => s.accountUid)).size}</strong> Churches attended</p></div>
      <p>Individual totals include individual special access. Churches and presenters are counted separately. Times use this device’s timezone.</p>
      <h3>Church attendance</h3><Visits sessions={report.sessions.filter((s) => s.audienceType === "church")} report={report} />
      <h3>Special access visits</h3><Visits sessions={report.sessions.filter((s) => s.specialAccessCode)} report={report} />
      <h3>Presenter attendance</h3><Visits sessions={report.sessions.filter((s) => s.audienceType === "presenter")} report={report} />
      <details><summary>Individual connection history</summary><Visits sessions={report.sessions.filter((s) => s.audienceType === "individual")} report={report} /></details>
      <button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${roomName}-attendance.json`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Download attendance data</button>
    </> : null}
  </dialog>;
}
