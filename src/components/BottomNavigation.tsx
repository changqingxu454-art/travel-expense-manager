export interface NavItem {
  path: string;
  label: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '首页', icon: '🏠' },
  { path: '/trips', label: '出差', icon: '🧳' },
  { path: '/invoices', label: '发票', icon: '🧾' },
];

function isActive(currentPath: string, itemPath: string): boolean {
  if (itemPath === '/') {
    return currentPath === '/';
  }
  return currentPath === itemPath || currentPath.startsWith(`${itemPath}/`);
}

interface BottomNavigationProps {
  /** 当前 hash 路由路径，例如 "/trips/abc"。 */
  currentPath: string;
}

/** 移动端底部导航；使用 hash 链接，天然兼容 GitHub Pages 静态托管。 */
export default function BottomNavigation({ currentPath }: BottomNavigationProps) {
  return (
    <nav className="bottom-nav" aria-label="主导航">
      {NAV_ITEMS.map((item) => {
        const active = isActive(currentPath, item.path);
        return (
          <a
            key={item.path}
            className={active ? 'bottom-nav__item bottom-nav__item--active' : 'bottom-nav__item'}
            href={`#${item.path}`}
            aria-current={active ? 'page' : undefined}
          >
            <span className="bottom-nav__icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="bottom-nav__label">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
