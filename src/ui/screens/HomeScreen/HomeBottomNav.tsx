import { Link } from 'react-router-dom';

export default function HomeBottomNav(props: { moreTarget?: string }) {
  const moreTarget = props.moreTarget ?? 'home-more';
  const openMore = () => {
    const element = document.getElementById(moreTarget);
    if (element instanceof HTMLDetailsElement) element.open = true;
  };
  return (
    <nav className="home-bottom-nav" aria-label="メインナビゲーション">
      <Link to="/" aria-current="page"><span aria-hidden="true">⌂</span>ホーム</Link>
      <Link to="/history"><span aria-hidden="true">◷</span>履歴</Link>
      <Link to="/messages"><span aria-hidden="true">✉</span>メッセージ</Link>
      <a href={`#${moreTarget}`} onClick={openMore}><span aria-hidden="true">•••</span>その他</a>
    </nav>
  );
}
