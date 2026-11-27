// A friendly "bring your history" entry point for empty states a new user sees (gym, plans, food log). Links to /import.
import { Link } from 'react-router';
import { Icon } from './Icon';

export function ImportHint({ from }: { from: string }) {
  return (
    <Link to="/import" className="import-hint pressable">
      <span className="import-hint-ic" aria-hidden><Icon name="download" size={18} stroke={2.2} /></span>
      <span className="grow"><span className="import-hint-q">Coming from {from}?</span><b>Import</b></span>
      <Icon name="chevronRight" size={16} className="chev" />
    </Link>
  );
}
