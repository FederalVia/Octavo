import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onClose: () => void;
}

interface State {
  error: Error | null;
}

/** Shows a full-screen error with Reload/Close instead of unmounting the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="drawing-view">
        <div className="dv-error">
          <p>Something went wrong: {error.message || String(error)}</p>
          <p>
            <button onClick={() => location.reload()}>Reload</button>{' '}
            <button onClick={this.props.onClose}>Close</button>
          </p>
        </div>
      </div>
    );
  }
}
