import type { ReactNode } from 'react';
import BottomNavigation from './BottomNavigation';

interface AppLayoutProps {
  title: string;
  currentPath: string;
  /** 标题右侧可选操作区。 */
  headerAction?: ReactNode;
  children: ReactNode;
}

/** 全局页面骨架：顶部标题栏 + 内容区 + 底部导航。 */
export default function AppLayout({
  title,
  currentPath,
  headerAction,
  children,
}: AppLayoutProps) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-header__title">{title}</h1>
        {headerAction ? <div className="app-header__action">{headerAction}</div> : null}
      </header>
      <main className="app-main">{children}</main>
      <BottomNavigation currentPath={currentPath} />
    </div>
  );
}
