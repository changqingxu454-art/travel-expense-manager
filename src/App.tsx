import { useEffect, useState } from 'react';
import AppLayout from './components/AppLayout';
import Dashboard from './pages/Dashboard';
import Invoices from './pages/Invoices';
import TripDetail from './pages/TripDetail';
import Trips from './pages/Trips';

/** 从 location.hash 解析出应用内路径，例如 "#/trips/abc" -> "/trips/abc"。 */
export function resolvePath(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const path = raw.split('?')[0] ?? '';
  if (path === '' || !path.startsWith('/')) {
    return '/';
  }
  // 去掉结尾多余的斜杠，"#" 与 "#/" 都视为首页。
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function useHashPath(): string {
  const [path, setPath] = useState(() =>
    typeof window === 'undefined' ? '/' : resolvePath(window.location.hash),
  );

  useEffect(() => {
    const onChange = () => setPath(resolvePath(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return path;
}

const TITLES: Record<string, string> = {
  '/': '差旅小账本',
  '/trips': '出差记录',
  '/invoices': '发票管理',
};

function renderPage(path: string) {
  const tripDetailMatch = /^\/trips\/(.+)$/.exec(path);
  if (tripDetailMatch && tripDetailMatch[1]) {
    return <TripDetail tripId={decodeURIComponent(tripDetailMatch[1])} />;
  }
  if (path === '/trips') {
    return <Trips />;
  }
  if (path === '/invoices') {
    return <Invoices />;
  }
  if (path === '/') {
    return <Dashboard />;
  }
  return (
    <section className="page">
      <p className="page__meta">页面不存在：{path}</p>
    </section>
  );
}

function getTitle(path: string): string {
  if (path.startsWith('/trips/')) {
    return '出差详情';
  }
  return TITLES[path] ?? '差旅小账本';
}

export default function App() {
  const path = useHashPath();
  return (
    <AppLayout title={getTitle(path)} currentPath={path}>
      {renderPage(path)}
    </AppLayout>
  );
}
