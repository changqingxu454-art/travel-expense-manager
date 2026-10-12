import type { ReactNode } from 'react';

interface EmptyStateProps {
  title: string;
  description?: string;
  /** 可选的操作按钮/链接。 */
  action?: ReactNode;
}

/** 统一的空状态展示：列表为空或功能尚未开放时使用。 */
export default function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <p className="empty-state__title">{title}</p>
      {description ? <p className="empty-state__desc">{description}</p> : null}
      {action ? <div className="empty-state__action">{action}</div> : null}
    </div>
  );
}
