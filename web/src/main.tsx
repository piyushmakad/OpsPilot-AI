import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Role = 'customer' | 'manager';
type Auth = { role: Role; password: string };
type Run = { id: string; requestText?: string; request_text?: string; scenario: string;
  status: string; outputText?: string | null; output_text?: string | null; createdAt?: string; created_at?: string };
type Event = { sequence: number; kind: string; payload: Record<string, any>; createdAt: string };
type Detail = { run: Run; events: Event[]; operation: Record<string, any> | null;
  approval: Record<string, any> | null; notification: Record<string, any> | null };
type Approval = { id: string; run_id: string; request_text: string; parameters: {
  paymentId: string; amountCents: number }; status: string; expires_at: string };

const scenarioInfo: Record<string, { title: string; detail: string }> = {
  small: { title: 'Small refund', detail: 'Automatic refund and WhatsApp confirmation' },
  'large-approve': { title: 'Approval required', detail: 'Manager approves a high value refund' },
  'large-reject': { title: 'Approval rejected', detail: 'No refund or notification' },
  'already-refunded': { title: 'Already refunded', detail: 'Stops before another side effect' },
  'provider-503': { title: 'Provider 503', detail: 'Durable backoff, then retry' },
  timeout: { title: 'Unknown outcome', detail: 'Reconcile a committed refund after timeout' },
  'no-payment': { title: 'No payment', detail: 'Invalidate the plan and explain' },
};

async function api<T>(auth: Auth, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: {
    authorization: `Basic ${btoa(`${auth.role}:${auth.password}`)}`,
    ...(init?.body ? { 'content-type': 'application/json' } : {}),
  }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}

function short(id: string): string { return id.slice(0, 8); }
function money(cents: number): string { return `$${(cents / 100).toFixed(2)}`; }
function time(value?: string): string { return value ? new Date(value).toLocaleTimeString() : '—'; }

function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [role, setRole] = useState<Role>('customer');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [scenario, setScenario] = useState('small');
  const [goal, setGoal] = useState('Refund my latest payment and WhatsApp me when it is done.');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');

  useEffect(() => {
    if (!auth) return;
    let live = true;
    const refresh = async () => {
      try {
        const list = await api<{ runs: Run[] }>(auth, '/api/runs');
        if (live) setRuns(list.runs);
        if (selected) {
          const item = await api<Detail>(auth, `/api/runs/${selected}`);
          if (live) setDetail(item);
        }
        if (auth.role === 'manager') {
          const queue = await api<{ approvals: Approval[] }>(auth, '/api/approvals');
          if (live) setApprovals(queue.approvals);
        }
      } catch (e) { if (live) setError((e as Error).message); }
    };
    void refresh();
    const interval = window.setInterval(refresh, 1500);
    return () => { live = false; window.clearInterval(interval); };
  }, [auth, selected]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const candidate = { role, password };
    try { await api(candidate, '/api/scenarios'); setAuth(candidate); setPassword(''); }
    catch (e) { setError((e as Error).message); }
  }
  async function create() {
    if (!auth) return;
    setBusy(true); setError('');
    try {
      const data = await api<{ run: Run }>(auth, '/api/runs', {
        method: 'POST', body: JSON.stringify({ goal, scenario }),
      });
      setSelected(data.run.id);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
    if (!auth) return;
    setBusy(true); setError('');
    try { await api(auth, `/api/approvals/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function sendReply() {
    if (!auth || !selected) return;
    setBusy(true); setError('');
    try { await api(auth, `/api/runs/${selected}/reply`, { method: 'POST', body: JSON.stringify({ answer: reply }) }); setReply(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!auth) return <div className="login-shell"><div className="login-card">
    <div className="brand-mark">O<span>✦</span></div>
    <p className="eyebrow">OPS PILOT / CONTROL ROOM</p>
    <h1>Agent operations,<br /><em>under control.</em></h1>
    <p className="muted">Explore a durable agent run, inspect every decision, and approve sensitive actions.</p>
    <form onSubmit={login}>
      <label>Demo role<select value={role} onChange={e => setRole(e.target.value as Role)}>
        <option value="customer">Customer</option><option value="manager">Manager</option>
      </select></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <button className="primary" type="submit">Enter workspace <span>→</span></button>
    </form>
    {error && <p className="error">{error}</p>}
    <p className="hint">Use the passwords set on the local API process.</p>
  </div></div>;

  const current = detail?.run.id === selected ? detail : null;
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="sidebar-brand"><div className="brand-mark small">O<span>✦</span></div><div><strong>OpsPilot AI</strong><small>Agent control room</small></div></div>
      <div className="nav-label">WORKSPACE</div><div className="nav-active">◈ &nbsp; Run inspector</div>
      <div className="sidebar-bottom"><span className="online-dot" /> Local demo · {auth.role}
        <button onClick={() => { setAuth(null); setSelected(null); setDetail(null); }}>Switch role</button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div><span className="eyebrow">DAY 03 / MULTI-STEP AGENT</span><h1>Run inspector</h1></div>
        <div className="top-pill"><span className="online-dot" /> Worker polling</div></header>
      {error && <div className="error banner" onClick={() => setError('')}>{error} <span>×</span></div>}
      <div className="content-grid"><div className="left-column">
        {auth.role === 'customer' && <section className="panel launch">
          <div className="panel-heading"><div><span className="eyebrow">START A RUN</span><h2>Give the agent a goal</h2></div><span className="panel-icon">↗</span></div>
          <label>Demo scenario<select value={scenario} onChange={e => setScenario(e.target.value)}>
            {Object.entries(scenarioInfo).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}
          </select></label>
          <p className="scenario-detail">{scenarioInfo[scenario]?.detail}</p>
          <label>Goal<textarea value={goal} onChange={e => setGoal(e.target.value)} rows={3} /></label>
          <button className="primary" disabled={busy || !goal.trim()} onClick={create}>Start agent run <span>→</span></button>
        </section>}
        {auth.role === 'manager' && <section className="panel approval-panel">
          <div className="panel-heading"><div><span className="eyebrow">HUMAN IN THE LOOP</span><h2>Approval queue</h2></div><span className="count">{approvals.length}</span></div>
          {approvals.length ? approvals.map(a => <div className="approval-card" key={a.id}>
            <div className="approval-head"><strong>Refund {money(a.parameters.amountCents)}</strong><span className="status waiting">PENDING</span></div>
            <p>{a.request_text}</p><div className="mono">Payment {short(a.parameters.paymentId)} · Expires {time(a.expires_at)}</div>
            <div className="approval-actions"><button disabled={busy} onClick={() => decide(a.id, 'APPROVED')}>Approve</button>
              <button className="danger" disabled={busy} onClick={() => decide(a.id, 'REJECTED')}>Reject</button></div>
          </div>) : <p className="empty">No approvals waiting. Start a large refund as customer, then return here.</p>}
        </section>}
        <section className="panel runs-panel"><div className="panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Agent runs</h2></div><span className="count">{runs.length}</span></div>
          {runs.length ? runs.map(run => <button className={`run-row ${selected === run.id ? 'selected' : ''}`} key={run.id} onClick={() => setSelected(run.id)}>
            <div className="run-row-top"><strong>{scenarioInfo[run.scenario]?.title ?? run.scenario}</strong><span className={`status ${run.status}`}>{run.status.replaceAll('_', ' ')}</span></div>
            <p>{run.requestText ?? run.request_text}</p><small>#{short(run.id)} · {time(run.createdAt ?? run.created_at)}</small>
          </button>) : <p className="empty">No runs yet. Start with the small refund scenario.</p>}
        </section>
      </div><div className="right-column">
        <section className="panel trace-panel"><div className="panel-heading"><div><span className="eyebrow">EXECUTION TRACE</span><h2>{current ? scenarioInfo[current.run.scenario]?.title ?? 'Agent run' : 'Select a run'}</h2></div>
          {current && <span className={`status ${current.run.status}`}>{current.run.status.replaceAll('_', ' ')}</span>}</div>
          {current ? <>
            <div className="goal-box"><span>USER GOAL</span><p>{current.run.requestText}</p></div>
            <div className="metrics"><div><small>RUN ID</small><strong className="mono">{short(current.run.id)}</strong></div>
              <div><small>EVENTS</small><strong>{current.events.length}</strong></div><div><small>SCENARIO</small><strong>{current.run.scenario}</strong></div></div>
            <div className="timeline">
              <div className="timeline-title">Timeline <span>{current.events.length} recorded events</span></div>
              {current.events.map(e => <TraceEvent key={e.sequence} event={e} />)}
              {current.approval && <div className="trace-event"><div className="trace-node approval-node">✓</div><div className="trace-content"><div className="trace-top"><strong>Human approval</strong><time>{time(current.approval.created_at)}</time></div>
                <p>Exact refund {money(current.approval.parameters.amountCents)} · {current.approval.status}</p>
                <small className="mono">Approval {short(current.approval.id)}</small></div></div>}
              {current.operation && <div className="trace-event"><div className="trace-node operation-node">↻</div><div className="trace-content"><div className="trace-top"><strong>Refund operation</strong><time>{time(current.operation.updated_at)}</time></div>
                <p>Status: <b>{current.operation.status}</b> · Attempts: {current.operation.attempt_count}</p>
                <small className="mono">Idempotency: {current.operation.idempotency_key}</small>
                {current.operation.last_error && <p className="warning-text">{current.operation.last_error}</p>}</div></div>}
              {current.notification && <div className="trace-event"><div className="trace-node success-node">✓</div><div className="trace-content"><div className="trace-top"><strong>WhatsApp confirmation</strong><time>{time(current.notification.created_at)}</time></div>
                <p>Mock notification persisted after trusted refund success.</p></div></div>}
            </div>
            {current.run.status === 'waiting_input' && auth.role === 'customer' && <div className="reply-box"><textarea value={reply} onChange={e => setReply(e.target.value)} placeholder="Answer the agent's question" />
              <button onClick={sendReply} disabled={busy || !reply.trim()}>Send reply</button></div>}
            {(current.run.outputText || current.run.output_text) && <div className="final-box"><span>FINAL RESPONSE</span><p>{current.run.outputText ?? current.run.output_text}</p></div>}
          </> : <div className="trace-empty"><div>◈</div><h3>Every action has a record.</h3><p>Select a run to see plans, parallel reads, approvals, retries, and the final outcome.</p></div>}
        </section>
      </div></div>
    </main>
  </div>;
}

function TraceEvent({ event }: { event: Event }) {
  const d = event.payload;
  const isDecision = event.kind === 'workflow_decision';
  const title = isDecision ? d.kind === 'plan' ? 'Plan recorded' : d.kind === 'call_tools' ? 'Tool selection' :
    d.kind === 'final' ? 'Final decision' : d.kind === 'clarify' ? 'Clarification' : 'Escalation' :
    d.type === 'plan_recorded' ? `Plan v${d.version}` : d.type === 'user_reply' ? 'User reply' :
    d.execution === 'parallel' ? 'Parallel observations' : 'Tool observation';
  return <div className="trace-event"><div className={`trace-node ${isDecision ? '' : 'result-node'}`}>{isDecision ? '◆' : '•'}</div>
    <div className="trace-content"><div className="trace-top"><strong>{title}</strong><time>{time(event.createdAt)}</time></div>
      {d.reasonSummary && <p>{d.reasonSummary}</p>}
      {d.steps && <ol>{d.steps.map((step: string, i: number) => <li key={i}>{step}</li>)}</ol>}
      {d.calls && <div className="tool-list">{d.calls.map((call: { name: string; args: Record<string, unknown> }, i: number) =>
        <span key={i}>{call.name} <small>{Object.keys(call.args).length ? JSON.stringify(call.args) : ''}</small></span>)}</div>}
      {d.observations?.length > 0 && <div className="tool-list">{d.observations.map((o: { name: string; result: unknown; latencyMs: number }, i: number) =>
        <details key={i}><summary>{o.name} <small>{o.latencyMs} ms · inspect result</small></summary><pre>{JSON.stringify(o.result, null, 2)}</pre></details>)}</div>}
      {d.text && <p>{d.text}</p>}
      {d.execution && <small className="execution-tag">{d.execution} execution</small>}
    </div></div>;
}

createRoot(document.getElementById('root')!).render(<App />);
