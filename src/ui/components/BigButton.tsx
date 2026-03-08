export default function BigButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'danger' | 'neutral';
  size?: 'default' | 'compact';
  hint?: string;
}) {
  const { label, onClick, disabled, variant = 'primary', size = 'default', hint } = props;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`big-button big-button--${variant} big-button--${size}`}
    >
      <span className="big-button__label">{label}</span>
      {hint && <span className="big-button__hint">{hint}</span>}
    </button>
  );
}
