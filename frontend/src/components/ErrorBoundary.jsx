import { Component } from 'react';
import { PageError } from '../layout/AppShell.jsx';

/** Keeps one broken page from blanking the whole app. Resets when `resetKey` changes (navigation). */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  componentDidCatch(error, info) {
    console.error('Page error', error, info?.componentStack);
  }
  render() {
    if (this.state.error) return <PageError error={this.state.error} reset={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
