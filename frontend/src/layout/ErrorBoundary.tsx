import { Component, type ErrorInfo, type ReactNode } from 'react';

// A render error anywhere below unmounts the whole React tree, which shows as a BLANK PAGE with
// nothing to go on. This catches it and shows what threw, plus a way back — the app's state is
// gone either way, but the failure is at least legible and reportable.
//
// It is a safety net, not a substitute for handling partial data: the crash that motivated it was
// an auto-process result fetched mid-run, before 'Search for electrodes' had produced a lead.

interface State {
  error: Error | null;
  info: string;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep it in the console too — the stack there is more useful than the summary below.
    console.error('render error:', error, info.componentStack);
    this.setState({ info: (info.componentStack ?? '').split('\n').slice(0, 6).join('\n') });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: 'inherit', color: 'var(--text)', overflow: 'auto', height: '100%' }}>
        <h2 style={{ color: 'var(--err)', marginTop: 0 }}>Something broke while rendering</h2>
        <pre style={pre}>{String(error.stack || error.message || error)}</pre>
        {info && <pre style={{ ...pre, color: 'var(--muted)' }}>{info}</pre>}
        <button onClick={() => this.setState({ error: null, info: '' })} style={{ marginRight: 8 }}>
          Try again
        </button>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

const pre: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  background: 'var(--panel)',
  border: '1px solid var(--panel-border)',
  borderRadius: 4,
  padding: 10,
  maxHeight: '40vh',
  overflow: 'auto',
};
