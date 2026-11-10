import { Component, type ErrorInfo, type ReactNode } from "react";

/** Une erreur dans une page ne doit pas vider tout l'écran : message, détail et rechargement. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("Erreur d'affichage", error, info.componentStack); }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });  // nouvelle page : on réessaie
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" role="alert" data-testid="error-boundary">
        <div className="panel section">
          <div className="eyebrow">Erreur</div>
          <h1 className="display">Cette page n'a pas pu s'afficher</h1>
          <p className="st-legend">{this.state.error.message}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Recharger</button>
        </div>
      </div>
    );
  }
}
