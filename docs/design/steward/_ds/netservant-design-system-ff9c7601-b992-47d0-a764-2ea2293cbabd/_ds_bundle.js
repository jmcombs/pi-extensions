/* @ds-bundle: {"format":3,"namespace":"BluePSL10KDesignSystem_ff9c76","components":[{"name":"Swatch","sourcePath":"components/brand/Swatch.jsx"},{"name":"Tok","sourcePath":"components/code/CodeBlock.jsx"},{"name":"CodeBlock","sourcePath":"components/code/CodeBlock.jsx"},{"name":"CommandBox","sourcePath":"components/code/CommandBox.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"ContactForm","sourcePath":"components/paper/ContactForm.jsx"},{"name":"FeatureItem","sourcePath":"components/paper/FeatureItem.jsx"},{"name":"PaperButton","sourcePath":"components/paper/PaperButton.jsx"},{"name":"PaperCard","sourcePath":"components/paper/PaperCard.jsx"},{"name":"TeamCard","sourcePath":"components/paper/TeamCard.jsx"}],"sourceHashes":{"components/brand/Swatch.jsx":"e7f66229f06b","components/code/CodeBlock.jsx":"691ceb5220b9","components/code/CommandBox.jsx":"15968c631bfc","components/core/Badge.jsx":"e8335b23fa28","components/core/Button.jsx":"30e8c4360136","components/core/Card.jsx":"ccdb2473908a","components/paper/ContactForm.jsx":"4d6c8ab82daf","components/paper/FeatureItem.jsx":"b46f68a14903","components/paper/PaperButton.jsx":"64c8a2714337","components/paper/PaperCard.jsx":"455e826bab7a","components/paper/TeamCard.jsx":"38f364de6060","ui_kits/paper-landing/paper-landing.jsx":"02d5ccbc4d3c","ui_kits/paper-landing/placeholders.jsx":"64ba072862f1"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.BluePSL10KDesignSystem_ff9c76 = window.BluePSL10KDesignSystem_ff9c76 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/Swatch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — Swatch
 * A palette color chip. On-brand atom for docs, pickers, and the theme's
 * own marketing. Shows color, name, hex; optional copy-on-click.
 */
function Swatch({
  color,
  name,
  hex,
  size = 'md',
  shape = 'rounded',
  copyable = false,
  style = {},
  ...rest
}) {
  const resolved = color || (hex ? hex : 'var(--accent)');
  const sizes = {
    sm: {
      sw: 32,
      font: 11,
      hexFont: 10
    },
    md: {
      sw: 44,
      font: 12,
      hexFont: 11
    },
    lg: {
      sw: 64,
      font: 13,
      hexFont: 12
    }
  };
  const s = sizes[size] || sizes.md;
  const radius = shape === 'circle' ? '50%' : shape === 'square' ? 'var(--radius-xs)' : 'var(--radius-sm)';
  const onClick = e => {
    if (copyable && hex && navigator.clipboard) navigator.clipboard.writeText(hex);
    if (rest.onClick) rest.onClick(e);
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      cursor: copyable ? 'pointer' : 'default',
      ...style
    }
  }, rest, {
    onClick: onClick
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      minWidth: s.sw,
      height: s.sw,
      background: resolved,
      borderRadius: radius,
      boxShadow: 'var(--shadow-xs)',
      border: '1px solid rgba(76,79,105,0.08)'
    }
  }), name || hex ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      lineHeight: 1.25
    }
  }, name ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: s.font,
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-primary)'
    }
  }, name) : null, hex ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: s.hexFont,
      color: 'var(--text-tertiary)'
    }
  }, hex) : null) : null);
}
Object.assign(__ds_scope, { Swatch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/Swatch.jsx", error: String((e && e.message) || e) }); }

// components/code/CodeBlock.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — CodeBlock & Tok
 * A syntax-highlighted code surface with optional filename chrome,
 * line numbers, and a window-dot header. `Tok` colors a span by token kind.
 */

const KIND = {
  comment: 'var(--syntax-comment)',
  keyword: 'var(--syntax-keyword)',
  string: 'var(--syntax-string)',
  number: 'var(--syntax-number)',
  constant: 'var(--syntax-constant)',
  function: 'var(--syntax-function)',
  type: 'var(--syntax-type)',
  variable: 'var(--syntax-variable)',
  parameter: 'var(--syntax-parameter)',
  operator: 'var(--syntax-operator)',
  tag: 'var(--syntax-tag)',
  attribute: 'var(--syntax-attribute)',
  property: 'var(--syntax-property)',
  punctuation: 'var(--syntax-punctuation)',
  escape: 'var(--syntax-escape)',
  regexp: 'var(--syntax-regexp)',
  macro: 'var(--syntax-macro)'
};
function Tok({
  kind = 'variable',
  italic,
  bold,
  children,
  style = {}
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      color: KIND[kind] || 'var(--text-primary)',
      fontStyle: italic || kind === 'comment' ? 'italic' : 'normal',
      fontWeight: bold ? 'var(--weight-bold)' : 'inherit',
      ...style
    }
  }, children);
}
function CodeBlock({
  filename,
  language,
  windowDots = false,
  lineNumbers = true,
  startLine = 1,
  lines,
  style = {},
  children,
  ...rest
}) {
  // `lines` may be an array of React nodes (one per row); else use children.
  const rows = lines || (typeof children === 'string' ? children.split('\n') : children);
  const rowArr = Array.isArray(rows) ? rows : [rows];
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      background: 'var(--surface-page)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-sm)',
      ...style
    }
  }, rest), filename || windowDots ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-3)',
      padding: '9px 14px',
      background: 'var(--surface-chrome)',
      borderBottom: '1px solid var(--border)'
    }
  }, windowDots ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: '50%',
      background: 'var(--latte-red)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: '50%',
      background: 'var(--latte-yellow)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 11,
      height: 11,
      borderRadius: '50%',
      background: 'var(--latte-green)'
    }
  })) : null, filename ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--text-secondary)'
    }
  }, filename) : null, language ? /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      color: 'var(--text-subtle)',
      textTransform: 'uppercase',
      letterSpacing: 'var(--tracking-wide)'
    }
  }, language) : null) : null, /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: '14px 0',
      overflowX: 'auto',
      fontFamily: 'var(--font-mono)',
      fontSize: 13,
      lineHeight: 'var(--leading-code)',
      color: 'var(--text-primary)'
    }
  }, rowArr.map((row, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'flex',
      padding: '0 16px',
      minHeight: '1.6em'
    }
  }, lineNumbers ? /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 'none',
      width: 30,
      marginRight: 16,
      textAlign: 'right',
      color: 'var(--latte-overlay1)',
      userSelect: 'none'
    }
  }, startLine + i) : null, /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'pre'
    }
  }, row)))));
}
Object.assign(__ds_scope, { Tok, CodeBlock });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/CodeBlock.jsx", error: String((e && e.message) || e) }); }

// components/code/CommandBox.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — CommandBox
 * A "Terminal window" CLI box for docs/marketing (e.g. install pages).
 * Authentic dark terminal regardless of page theme. Copy button included.
 *
 * `commands` is an array of lines:
 *   - normal line            → rendered as a command with a Path-Blue `$` prompt
 *   - line starting with `#` → rendered as a dimmed comment
 *   - line indented (2+ spaces / tab) → rendered as dimmed command output
 * Or pass `children` for full control.
 */
function CommandBox({
  title = 'Terminal window',
  commands = [],
  copyable = true,
  prompt = '$',
  style = {},
  children,
  ...rest
}) {
  const [copied, setCopied] = React.useState(false);
  const copyText = commands.filter(c => !c.trim().startsWith('#') && !/^(\s)/.test(c)).join('\n');
  const copy = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  const dot = c => ({
    width: 11,
    height: 11,
    borderRadius: '50%',
    background: c,
    flex: 'none'
  });
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      background: '#1e1e2e',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-md)',
      border: '1px solid rgba(205,214,244,0.08)',
      fontFamily: 'var(--font-mono)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '10px 14px',
      background: '#181825',
      borderBottom: '1px solid rgba(205,214,244,0.07)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: dot('#f38ba8')
  }), /*#__PURE__*/React.createElement("span", {
    style: dot('#f9e2af')
  }), /*#__PURE__*/React.createElement("span", {
    style: dot('#a6e3a1')
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      textAlign: 'center',
      fontSize: 12,
      color: '#9399b2',
      pointerEvents: 'none'
    }
  }, title), copyable ? /*#__PURE__*/React.createElement("button", {
    onClick: copy,
    style: {
      marginLeft: 'auto',
      zIndex: 1,
      background: 'transparent',
      border: 0,
      color: copied ? '#a6e3a1' : '#9399b2',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `codicon codicon-${copied ? 'check' : 'copy'}`,
    style: {
      fontSize: 13
    }
  }), copied ? 'Copied' : 'Copy') : null), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 16px',
      fontSize: 13.5,
      lineHeight: 1.7,
      color: '#cdd6f4',
      overflowX: 'auto'
    }
  }, children || commands.map((c, i) => {
    if (c.trim().startsWith('#')) return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        color: '#6c7086',
        whiteSpace: 'pre'
      }
    }, c);
    if (/^(\s)/.test(c)) return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        color: '#9399b2',
        whiteSpace: 'pre'
      }
    }, c);
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        whiteSpace: 'pre'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#7aa2d6',
        userSelect: 'none'
      }
    }, prompt, " "), c);
  })));
}
Object.assign(__ds_scope, { CommandBox });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/CommandBox.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — Badge
 * Compact status/label pill. Semantic presets map onto the Latte palette;
 * `dot` adds a leading status dot; `solid` fills, `soft` tints.
 */
function Badge({
  tone = 'neutral',
  variant = 'soft',
  dot = false,
  size = 'md',
  style = {},
  children,
  ...rest
}) {
  const toneColor = {
    neutral: 'var(--text-tertiary)',
    accent: 'var(--accent)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    error: 'var(--error)',
    info: 'var(--info)',
    mauve: 'var(--latte-mauve)',
    peach: 'var(--latte-peach)',
    pink: 'var(--latte-pink)',
    lavender: 'var(--latte-lavender)'
  }[tone] || 'var(--text-tertiary)';
  const sizes = {
    sm: {
      padding: dot ? '2px 8px 2px 7px' : '2px 8px',
      fontSize: 11,
      gap: 5,
      dotSize: 6
    },
    md: {
      padding: dot ? '4px 11px 4px 9px' : '4px 11px',
      fontSize: 12,
      gap: 6,
      dotSize: 7
    }
  };
  const s = sizes[size] || sizes.md;
  const variants = {
    soft: {
      background: `color-mix(in srgb, ${toneColor} 14%, transparent)`,
      color: toneColor,
      border: '1px solid transparent'
    },
    solid: {
      background: toneColor,
      color: 'var(--text-on-accent)',
      border: '1px solid transparent'
    },
    outline: {
      background: 'transparent',
      color: toneColor,
      border: `1px solid color-mix(in srgb, ${toneColor} 45%, transparent)`
    }
  };
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: s.gap,
      padding: s.padding,
      fontFamily: 'var(--font-ui)',
      fontSize: s.fontSize,
      fontWeight: 'var(--weight-semibold)',
      lineHeight: 1.2,
      borderRadius: 'var(--radius-full)',
      whiteSpace: 'nowrap',
      ...(variants[variant] || variants.soft),
      ...style
    }
  }, rest), dot ? /*#__PURE__*/React.createElement("span", {
    style: {
      width: s.dotSize,
      height: s.dotSize,
      borderRadius: '50%',
      background: variant === 'solid' ? 'currentColor' : toneColor,
      flex: 'none'
    }
  }) : null, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — Button
 * Path-blue primary, surface secondary, ghost, and a "spice" accent variant.
 * Editor-grade: small radii, calm transitions, Path Blue focus ring.
 */
function Button({
  variant = 'primary',
  size = 'md',
  accent,
  iconLeft,
  iconRight,
  disabled = false,
  type = 'button',
  style = {},
  children,
  ...rest
}) {
  const sizes = {
    sm: {
      padding: '5px 11px',
      fontSize: 13,
      height: 28,
      gap: 6
    },
    md: {
      padding: '8px 15px',
      fontSize: 14,
      height: 34,
      gap: 8
    },
    lg: {
      padding: '11px 20px',
      fontSize: 15,
      height: 42,
      gap: 9
    }
  };
  const s = sizes[size] || sizes.md;

  // "accent" optionally recolors primary/soft variants to any palette color.
  const accentColor = accent ? `var(--latte-${accent}, ${accent})` : 'var(--accent)';
  const accentHover = accent ? `var(--latte-${accent}, ${accent})` : 'var(--accent-hover)';
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    height: s.height,
    padding: s.padding,
    fontSize: s.fontSize,
    fontFamily: 'var(--font-ui)',
    fontWeight: 'var(--weight-semibold)',
    lineHeight: 1,
    letterSpacing: 'var(--tracking-snug)',
    border: '1px solid transparent',
    borderRadius: 'var(--radius-md)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
    userSelect: 'none',
    whiteSpace: 'nowrap'
  };
  const variants = {
    primary: {
      background: accentColor,
      color: 'var(--accent-fg)',
      borderColor: accentColor
    },
    secondary: {
      background: 'var(--surface-raised)',
      color: 'var(--text-primary)',
      borderColor: 'var(--border)'
    },
    ghost: {
      background: 'transparent',
      color: accentColor,
      borderColor: 'transparent'
    },
    soft: {
      background: `color-mix(in srgb, ${accentColor} 14%, transparent)`,
      color: accentColor,
      borderColor: 'transparent'
    },
    outline: {
      background: 'transparent',
      color: accentColor,
      borderColor: accentColor
    }
  };
  const hover = {
    primary: {
      background: accentHover,
      borderColor: accentHover
    },
    secondary: {
      background: 'var(--surface-raised-1)'
    },
    ghost: {
      background: `color-mix(in srgb, ${accentColor} 12%, transparent)`
    },
    soft: {
      background: `color-mix(in srgb, ${accentColor} 22%, transparent)`
    },
    outline: {
      background: `color-mix(in srgb, ${accentColor} 10%, transparent)`
    }
  };
  const onEnter = e => {
    if (!disabled) Object.assign(e.currentTarget.style, hover[variant] || {});
  };
  const onLeave = e => {
    if (!disabled) Object.assign(e.currentTarget.style, variants[variant] || {});
  };
  const onDown = e => {
    if (!disabled) e.currentTarget.style.transform = 'translateY(0.5px) scale(0.99)';
  };
  const onUp = e => {
    if (!disabled) e.currentTarget.style.transform = 'none';
  };
  const onFocus = e => {
    e.currentTarget.style.boxShadow = 'var(--ring)';
  };
  const onBlur = e => {
    e.currentTarget.style.boxShadow = 'none';
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    style: {
      ...base,
      ...(variants[variant] || variants.primary),
      ...style
    },
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onMouseDown: onDown,
    onMouseUp: onUp,
    onFocus: onFocus,
    onBlur: onBlur
  }, rest), iconLeft ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex'
    }
  }, iconLeft) : null, children, iconRight ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex'
    }
  }, iconRight) : null);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant — Card
 * A surface container. Light, border-led elevation (not heavy shadow).
 * Optional header (crust chrome bar) and accent top-rail.
 */
function Card({
  title,
  subtitle,
  headerRight,
  accentRail = false,
  accent = 'var(--accent)',
  padding = 'var(--space-5)',
  interactive = false,
  style = {},
  children,
  ...rest
}) {
  const onEnter = e => {
    if (interactive) {
      e.currentTarget.style.boxShadow = 'var(--shadow-md)';
      e.currentTarget.style.borderColor = 'var(--border-strong)';
    }
  };
  const onLeave = e => {
    if (interactive) {
      e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
      e.currentTarget.style.borderColor = 'var(--border)';
    }
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      background: 'var(--surface-page)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-sm)',
      overflow: 'hidden',
      transition: 'box-shadow var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out)',
      cursor: interactive ? 'pointer' : 'default',
      ...style
    },
    onMouseEnter: onEnter,
    onMouseLeave: onLeave
  }, rest), accentRail ? /*#__PURE__*/React.createElement("div", {
    style: {
      height: 3,
      background: accent
    }
  }) : null, title ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 'var(--space-3)',
      padding: 'var(--space-3) var(--space-5)',
      background: 'var(--surface-chrome)',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-heading)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--text-base)',
      color: 'var(--text-primary)',
      letterSpacing: 'var(--tracking-snug)'
    }
  }, title), subtitle ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 'var(--text-sm)',
      color: 'var(--text-tertiary)'
    }
  }, subtitle) : null), headerRight ? /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 'none'
    }
  }, headerRight) : null) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding
    }
  }, children));
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/paper/FeatureItem.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant × Paper Kit — FeatureItem
 * A feature block: pastel icon medallion + title + body + optional "see more" link.
 * `icon` is a codicon name (load @vscode/codicons in the host).
 */
function FeatureItem({
  icon = 'sparkle',
  accent = 'teal',
  // Catppuccin Latte accent name
  title,
  children,
  linkText,
  linkHref = '#',
  align = 'left',
  style = {},
  ...rest
}) {
  const color = `var(--latte-${accent}, ${accent})`;
  const centered = align === 'center';
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: centered ? 'center' : 'flex-start',
      textAlign: align,
      gap: 12,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 60,
      height: 60,
      borderRadius: 'var(--radius-full)',
      flex: 'none',
      background: `color-mix(in srgb, ${color} 15%, transparent)`,
      color,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("i", {
    className: `codicon codicon-${icon}`,
    style: {
      fontSize: 26
    }
  })), /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: 0,
      fontFamily: 'var(--font-heading)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--text-lg)',
      color: 'var(--text-primary)',
      letterSpacing: 'var(--tracking-snug)'
    }
  }, title), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--text-base)',
      lineHeight: 'var(--leading-normal)',
      color: 'var(--text-tertiary)'
    }
  }, children), linkText ? /*#__PURE__*/React.createElement("a", {
    href: linkHref,
    style: {
      marginTop: 2,
      fontFamily: 'var(--font-ui)',
      fontSize: 13,
      fontWeight: 'var(--weight-semibold)',
      color,
      textDecoration: 'none',
      textTransform: 'uppercase',
      letterSpacing: '0.05em'
    }
  }, linkText, " \u2192") : null);
}
Object.assign(__ds_scope, { FeatureItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/paper/FeatureItem.jsx", error: String((e && e.message) || e) }); }

// components/paper/PaperButton.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant × Paper Kit — PaperButton
 * The rounded "paper" pill button: full-radius by default, soft lift on hover.
 * Paper Kit shapes (pill, uppercase, tracking) + Netservant palette.
 */
function PaperButton({
  variant = 'fill',
  size = 'md',
  accent = 'path',
  // 'path' = Path Blue, or any Catppuccin Latte name
  round = true,
  uppercase = true,
  iconLeft,
  iconRight,
  block = false,
  disabled = false,
  type = 'button',
  style = {},
  children,
  ...rest
}) {
  const color = accent === 'path' ? 'var(--accent)' : `var(--latte-${accent}, ${accent})`;
  const colorHover = accent === 'path' ? 'var(--accent-hover)' : `color-mix(in srgb, ${color} 82%, black)`;
  const sizes = {
    sm: {
      padding: '7px 18px',
      fontSize: 12,
      gap: 7
    },
    md: {
      padding: '11px 26px',
      fontSize: 13.5,
      gap: 8
    },
    lg: {
      padding: '15px 36px',
      fontSize: 15,
      gap: 10
    }
  };
  const s = sizes[size] || sizes.md;
  const base = {
    display: block ? 'flex' : 'inline-flex',
    width: block ? '100%' : 'auto',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s.gap,
    padding: s.padding,
    fontFamily: 'var(--font-ui)',
    fontSize: s.fontSize,
    fontWeight: 'var(--weight-semibold)',
    lineHeight: 1.2,
    textTransform: uppercase ? 'uppercase' : 'none',
    letterSpacing: uppercase ? '0.06em' : '0',
    border: '2px solid transparent',
    borderRadius: round ? 'var(--radius-full)' : 'var(--radius-paper)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
    whiteSpace: 'nowrap',
    userSelect: 'none'
  };
  const variants = {
    fill: {
      background: color,
      color: 'var(--accent-fg)',
      borderColor: color,
      boxShadow: 'var(--shadow-sm)'
    },
    neutral: {
      background: 'var(--surface-page)',
      color,
      borderColor: 'transparent',
      boxShadow: 'var(--shadow-paper)'
    },
    outline: {
      background: 'transparent',
      color,
      borderColor: color,
      boxShadow: 'none'
    },
    link: {
      background: 'transparent',
      color,
      borderColor: 'transparent',
      boxShadow: 'none',
      padding: s.padding.replace(/\d+px$/, '6px')
    }
  };
  const hovers = {
    fill: {
      background: colorHover,
      borderColor: colorHover,
      boxShadow: 'var(--shadow-paper)',
      transform: 'translateY(-2px)'
    },
    neutral: {
      boxShadow: 'var(--shadow-paper-hover)',
      transform: 'translateY(-2px)'
    },
    outline: {
      background: `color-mix(in srgb, ${color} 10%, transparent)`,
      transform: 'translateY(-1px)'
    },
    link: {
      color: colorHover,
      transform: 'none'
    }
  };
  const v = variants[variant] || variants.fill;
  const enter = e => {
    if (!disabled) Object.assign(e.currentTarget.style, hovers[variant] || {});
  };
  const leave = e => {
    if (!disabled) Object.assign(e.currentTarget.style, v);
  };
  const down = e => {
    if (!disabled) e.currentTarget.style.transform = 'translateY(0) scale(0.98)';
  };
  const up = e => {
    if (!disabled) e.currentTarget.style.transform = (hovers[variant] || {}).transform || 'none';
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    style: {
      ...base,
      ...v,
      ...style
    },
    onMouseEnter: enter,
    onMouseLeave: leave,
    onMouseDown: down,
    onMouseUp: up
  }, rest), iconLeft ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex'
    }
  }, iconLeft) : null, children, iconRight ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex'
    }
  }, iconRight) : null);
}
Object.assign(__ds_scope, { PaperButton });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/paper/PaperButton.jsx", error: String((e && e.message) || e) }); }

// components/paper/ContactForm.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function PaperField({
  label,
  type = 'text',
  textarea,
  value,
  onChange,
  placeholder,
  name
}) {
  const [focus, setFocus] = React.useState(false);
  const shared = {
    width: '100%',
    boxSizing: 'border-box',
    fontFamily: 'var(--font-ui)',
    fontSize: 'var(--text-base)',
    color: 'var(--text-primary)',
    background: 'var(--surface-page)',
    border: `1px solid ${focus ? 'var(--border-active)' : 'var(--border)'}`,
    boxShadow: focus ? 'var(--ring)' : 'var(--shadow-xs)',
    outline: 'none',
    transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)'
  };
  return /*#__PURE__*/React.createElement("label", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 7
    }
  }, label ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 13,
      fontWeight: 'var(--weight-semibold)',
      color: 'var(--text-secondary)'
    }
  }, label) : null, textarea ? /*#__PURE__*/React.createElement("textarea", {
    name: name,
    rows: 4,
    value: value,
    onChange: onChange,
    placeholder: placeholder,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      ...shared,
      padding: '13px 18px',
      borderRadius: 'var(--radius-paper)',
      resize: 'vertical',
      minHeight: 96
    }
  }) : /*#__PURE__*/React.createElement("input", {
    name: name,
    type: type,
    value: value,
    onChange: onChange,
    placeholder: placeholder,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: {
      ...shared,
      padding: '12px 20px',
      borderRadius: 'var(--radius-full)'
    }
  }));
}

/**
 * Netservant × Paper Kit — ContactForm
 * "Keep in touch?" form: rounded paper fields + a pill submit.
 * Controlled internally; `onSubmit` receives { name, email, message }.
 */
function ContactForm({
  title = 'Keep in touch?',
  blurb,
  submitLabel = 'Send message',
  accent = 'path',
  onSubmit,
  align = 'center',
  style = {},
  ...rest
}) {
  const [data, setData] = React.useState({
    name: '',
    email: '',
    message: ''
  });
  const [sent, setSent] = React.useState(false);
  const set = k => e => setData(d => ({
    ...d,
    [k]: e.target.value
  }));
  const submit = e => {
    e.preventDefault();
    setSent(true);
    if (onSubmit) onSubmit(data);
  };
  return /*#__PURE__*/React.createElement("form", _extends({
    onSubmit: submit,
    style: {
      width: '100%',
      maxWidth: 540,
      margin: align === 'center' ? '0 auto' : 0,
      textAlign: align,
      ...style
    }
  }, rest), title ? /*#__PURE__*/React.createElement("h3", {
    style: {
      margin: '0 0 8px',
      fontFamily: 'var(--font-display)',
      fontWeight: 400,
      fontSize: 'var(--text-3xl)',
      color: 'var(--text-primary)'
    }
  }, title) : null, blurb ? /*#__PURE__*/React.createElement("p", {
    style: {
      margin: '0 0 26px',
      fontSize: 'var(--text-md)',
      lineHeight: 'var(--leading-normal)',
      color: 'var(--text-tertiary)'
    }
  }, blurb) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 180
    }
  }, /*#__PURE__*/React.createElement(PaperField, {
    label: "Name",
    name: "name",
    value: data.name,
    onChange: set('name'),
    placeholder: "Jane Latte"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 180
    }
  }, /*#__PURE__*/React.createElement(PaperField, {
    label: "Email",
    name: "email",
    type: "email",
    value: data.email,
    onChange: set('email'),
    placeholder: "jane@brew.dev"
  }))), /*#__PURE__*/React.createElement(PaperField, {
    label: "Message",
    name: "message",
    textarea: true,
    value: data.message,
    onChange: set('message'),
    placeholder: "Tell us how you take your coffee\u2026"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: align === 'center' ? 'center' : 'flex-start',
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.PaperButton, {
    type: "submit",
    size: "lg",
    accent: accent === 'path' ? 'path' : accent
  }, sent ? 'Sent ✓' : submitLabel))));
}
Object.assign(__ds_scope, { ContactForm });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/paper/ContactForm.jsx", error: String((e && e.message) || e) }); }

// components/paper/PaperCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant × Paper Kit — PaperCard
 * Soft, rounded "paper" surface (rounder + softer shadow than the core Card).
 * Optional pastel tint, media slot, and hover lift.
 */
function PaperCard({
  tint,
  // Catppuccin Latte accent name → soft pastel fill
  media,
  // node rendered flush at the top (image/placeholder)
  raised = true,
  // paper shadow
  interactive = false,
  align = 'left',
  padding = 'var(--space-6)',
  style = {},
  children,
  ...rest
}) {
  const tintBg = tint ? `color-mix(in srgb, var(--latte-${tint}, ${tint}) 10%, var(--surface-page))` : 'var(--surface-page)';
  const enter = e => {
    if (interactive) {
      e.currentTarget.style.boxShadow = 'var(--shadow-paper-hover)';
      e.currentTarget.style.transform = 'translateY(-4px)';
    }
  };
  const leave = e => {
    if (interactive) {
      e.currentTarget.style.boxShadow = raised ? 'var(--shadow-paper)' : 'none';
      e.currentTarget.style.transform = 'none';
    }
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      background: tintBg,
      borderRadius: 'var(--radius-paper)',
      boxShadow: raised ? 'var(--shadow-paper)' : 'none',
      border: raised ? 'none' : '1px solid var(--border)',
      overflow: 'hidden',
      textAlign: align,
      transition: 'box-shadow var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out)',
      cursor: interactive ? 'pointer' : 'default',
      ...style
    },
    onMouseEnter: enter,
    onMouseLeave: leave
  }, rest), media ? /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%'
    }
  }, media) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding
    }
  }, children));
}
Object.assign(__ds_scope, { PaperCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/paper/PaperCard.jsx", error: String((e && e.message) || e) }); }

// components/paper/TeamCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Netservant × Paper Kit — TeamCard
 * A person card: round avatar (photo node), name, role, quote, social row.
 * Paper "paper" surface + pastel accent role.
 */
function TeamCard({
  avatar,
  // node (Avatar / image / placeholder)
  name,
  role,
  accent = 'mauve',
  // Catppuccin Latte accent name for the role label
  socials = [],
  // [{ icon: 'github', href: '#' }] — codicon names
  raised = true,
  style = {},
  children,
  ...rest
}) {
  const color = `var(--latte-${accent}, ${accent})`;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      textAlign: 'center',
      gap: 14,
      padding: 'var(--space-8) var(--space-6)',
      background: 'var(--surface-page)',
      borderRadius: 'var(--radius-paper)',
      boxShadow: raised ? 'var(--shadow-paper)' : 'none',
      border: raised ? 'none' : '1px solid var(--border)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 110,
      height: 110,
      borderRadius: 'var(--radius-full)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-sm)'
    }
  }, avatar), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-heading)',
      fontWeight: 'var(--weight-semibold)',
      fontSize: 'var(--text-lg)',
      color: 'var(--text-primary)'
    }
  }, name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-ui)',
      fontSize: 13,
      fontWeight: 'var(--weight-medium)',
      color,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      marginTop: 3
    }
  }, role)), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: 0,
      fontSize: 'var(--text-base)',
      lineHeight: 'var(--leading-normal)',
      color: 'var(--text-tertiary)',
      maxWidth: 320
    }
  }, children), socials.length ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginTop: 4
    }
  }, socials.map((s, i) => /*#__PURE__*/React.createElement("a", {
    key: i,
    href: s.href || '#',
    "aria-label": s.icon,
    style: {
      width: 36,
      height: 36,
      borderRadius: 'var(--radius-full)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
      color,
      textDecoration: 'none',
      transition: 'background var(--dur-fast) var(--ease-out)'
    },
    onMouseEnter: e => e.currentTarget.style.background = `color-mix(in srgb, ${color} 22%, transparent)`,
    onMouseLeave: e => e.currentTarget.style.background = `color-mix(in srgb, ${color} 12%, transparent)`
  }, /*#__PURE__*/React.createElement("i", {
    className: `codicon codicon-${s.icon}`,
    style: {
      fontSize: 16
    }
  })))) : null);
}
Object.assign(__ds_scope, { TeamCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/paper/TeamCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/paper-landing/paper-landing.jsx
try { (() => {
// Netservant × Paper Kit — landing sections (composes DS components + placeholders)
const NS = window.BluePSL10KDesignSystem_ff9c76;
const {
  PaperButton,
  PaperCard,
  FeatureItem,
  TeamCard,
  ContactForm
} = NS;
const {
  Photo,
  Avatar
} = window;
const WRAP = {
  maxWidth: 1120,
  margin: '0 auto',
  padding: '0 32px'
};
const NET_E = '../../assets/netservant-e.png';
const NET_E_WHITE = '../../assets/netservant-e-white.png';
function NetLogo({
  u = 26,
  inverted = false
}) {
  const dark = inverted ? '#fff' : 'var(--latte-text)';
  const slate = inverted ? 'color-mix(in srgb, #fff 76%, var(--psl-path-blue))' : 'var(--latte-subtext1)';
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      fontSize: u,
      fontFamily: 'var(--font-sans)',
      letterSpacing: '-0.02em',
      lineHeight: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: dark
    }
  }, "N"), /*#__PURE__*/React.createElement("img", {
    src: inverted ? NET_E_WHITE : NET_E,
    alt: "e",
    style: {
      height: '1.55em',
      margin: '0 -0.06em',
      display: 'block'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: dark
    }
  }, "t"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      color: dark
    }
  }, "servant"));
}
function Eyebrow({
  accent = 'path',
  children
}) {
  const c = accent === 'path' ? 'var(--accent)' : `var(--latte-${accent})`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      letterSpacing: 'var(--tracking-caps)',
      textTransform: 'uppercase',
      color: c,
      marginBottom: 16
    }
  }, children);
}
function Nav() {
  return /*#__PURE__*/React.createElement("nav", {
    style: {
      position: 'sticky',
      top: 0,
      zIndex: 30,
      background: 'color-mix(in srgb, var(--surface-page) 80%, transparent)',
      backdropFilter: 'blur(12px)',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      height: 72,
      display: 'flex',
      alignItems: 'center',
      gap: 14
    }
  }, /*#__PURE__*/React.createElement(NetLogo, {
    u: 26
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 28,
      fontSize: 14,
      fontWeight: 500,
      color: 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#product",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "Services"), /*#__PURE__*/React.createElement("a", {
    href: "#features",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "What we do"), /*#__PURE__*/React.createElement("a", {
    href: "#team",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "Team"), /*#__PURE__*/React.createElement("a", {
    href: "#contact",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "Contact")), /*#__PURE__*/React.createElement(PaperButton, {
    size: "sm"
  }, "Contact us")));
}
function Hero() {
  return /*#__PURE__*/React.createElement("header", {
    style: {
      position: 'relative',
      minHeight: 560,
      display: 'flex',
      alignItems: 'center',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0
    }
  }, /*#__PURE__*/React.createElement(Photo, {
    seed: "hero",
    radius: "0",
    height: "100%"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'linear-gradient(180deg, color-mix(in srgb, var(--latte-text) 30%, transparent), color-mix(in srgb, var(--latte-text) 55%, transparent))'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      position: 'relative',
      textAlign: 'center',
      color: '#fff'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 12.5,
      letterSpacing: 'var(--tracking-caps)',
      textTransform: 'uppercase',
      opacity: 0.92,
      marginBottom: 18
    }
  }, "Netservant, LLC \xB7 Since 1998"), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 400,
      fontSize: 72,
      lineHeight: 1.04,
      margin: '0 auto',
      maxWidth: 820,
      textShadow: '0 2px 20px rgba(76,79,105,0.35)'
    }
  }, "At your network\u2019s service"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 19,
      lineHeight: 1.6,
      maxWidth: 560,
      margin: '22px auto 32px',
      opacity: 0.95
    }
  }, "Netservant is your partner for dependable IT, infrastructure, and the kind of support that actually answers the phone. Tell us what you need."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 14,
      justifyContent: 'center',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(PaperButton, {
    size: "lg"
  }, "Get in touch"), /*#__PURE__*/React.createElement(PaperButton, {
    size: "lg",
    variant: "neutral",
    iconLeft: /*#__PURE__*/React.createElement("i", {
      className: "codicon codicon-list-unordered"
    })
  }, "Our services"))));
}
function TalkProduct() {
  return /*#__PURE__*/React.createElement("section", {
    id: "product",
    style: {
      ...WRAP,
      padding: '96px 32px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 56,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement(Photo, {
    seed: "product",
    height: 360,
    label: "Your network",
    icon: "server",
    style: {
      boxShadow: 'var(--shadow-paper)'
    }
  }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Eyebrow, null, "Let\u2019s talk service"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 400,
      fontSize: 44,
      lineHeight: 1.08,
      margin: '0 0 18px',
      color: 'var(--text-primary)'
    }
  }, "Service that actually answers"), /*#__PURE__*/React.createElement("p", {
    style: {
      fontSize: 17,
      lineHeight: 1.65,
      color: 'var(--text-tertiary)',
      margin: '0 0 28px',
      maxWidth: 460
    }
  }, "Since 1998 we\u2019ve treated every network like it\u2019s our own. No ticket black holes, no jargon \u2014 just steady hands keeping your systems online and a real person who knows your setup."), /*#__PURE__*/React.createElement(PaperButton, {
    variant: "outline",
    accent: "path",
    iconRight: /*#__PURE__*/React.createElement("i", {
      className: "codicon codicon-arrow-right"
    })
  }, "See details")));
}
const FEATURES = [['server', 'teal', 'Managed infrastructure', 'Servers, networks, and the boring-but-critical things — monitored and handled.'], ['cloud', 'peach', 'Cloud & DevOps', 'Provisioning, pipelines, and infrastructure-as-code that scales with you.'], ['shield', 'mauve', 'Security & backup', 'Patching, monitoring, and backups you never have to think about.'], ['comment-discussion', 'green', 'Real human support', 'When something breaks, a person who knows your setup picks up.']];
function Features() {
  return /*#__PURE__*/React.createElement("section", {
    id: "features",
    style: {
      background: 'var(--surface-panel)',
      borderTop: '1px solid var(--border)',
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      padding: '88px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      marginBottom: 48
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    accent: "teal"
  }, "What we do"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 400,
      fontSize: 46,
      margin: 0,
      color: 'var(--text-primary)'
    }
  }, "Built to keep you running")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
      gap: 20
    }
  }, FEATURES.map(([icon, accent, title, body]) => /*#__PURE__*/React.createElement(PaperCard, {
    key: title,
    tint: accent,
    interactive: true,
    align: "center"
  }, /*#__PURE__*/React.createElement(FeatureItem, {
    icon: icon,
    accent: accent,
    title: title,
    align: "center"
  }, body))))));
}
const TEAM = [['HF', 'Henry Ford', 'Product Manager', 'mauve', 'stats', 'Teamwork is so important that it is virtually impossible to reach the heights of your capabilities without becoming very good at it.'], ['SW', 'Sophie West', 'Designer', 'teal', 'gallery', 'A group becomes a team when each member is sure enough of themselves to praise the skill of the others. It takes an orchestra to play a symphony.'], ['RO', 'Robert Orben', 'Developer', 'peach', 'ideas', 'The strength of the team is each member. The strength of each member is the team. If you can laugh together, you can work together.']];
function Team() {
  return /*#__PURE__*/React.createElement("section", {
    id: "team",
    style: {
      ...WRAP,
      padding: '96px 32px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      marginBottom: 48
    }
  }, /*#__PURE__*/React.createElement(Eyebrow, {
    accent: "mauve"
  }, "Let\u2019s talk about us"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--font-display)',
      fontWeight: 400,
      fontSize: 46,
      margin: 0,
      color: 'var(--text-primary)'
    }
  }, "The people behind the service")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
      gap: 24
    }
  }, TEAM.map(([initials, name, role, accent, seed, quote]) => /*#__PURE__*/React.createElement(TeamCard, {
    key: name,
    name: name,
    role: role,
    accent: accent,
    avatar: /*#__PURE__*/React.createElement(Avatar, {
      seed: seed,
      initials: initials
    }),
    socials: [{
      icon: 'github'
    }, {
      icon: 'twitter'
    }, {
      icon: 'link'
    }]
  }, quote))));
}
function Contact() {
  return /*#__PURE__*/React.createElement("section", {
    id: "contact",
    style: {
      background: 'color-mix(in srgb, var(--accent) 7%, var(--surface-page))',
      borderTop: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      padding: '88px 32px'
    }
  }, /*#__PURE__*/React.createElement(ContactForm, {
    title: "How may we help you?",
    blurb: "Tell us what you need \u2014 we read every message."
  })));
}
function Footer() {
  return /*#__PURE__*/React.createElement("footer", {
    style: {
      background: 'var(--surface-chrome)',
      borderTop: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      ...WRAP,
      padding: '40px 32px',
      display: 'flex',
      alignItems: 'center',
      gap: 16,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement(NetLogo, {
    u: 20
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 22,
      marginLeft: 24,
      fontSize: 14,
      color: 'var(--text-secondary)'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "#product",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "Services"), /*#__PURE__*/React.createElement("a", {
    href: "#features",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "What we do"), /*#__PURE__*/React.createElement("a", {
    href: "#team",
    style: {
      color: 'inherit',
      textDecoration: 'none'
    }
  }, "Team")), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 13,
      color: 'var(--text-tertiary)',
      fontFamily: 'var(--font-mono)'
    }
  }, "Netservant, LLC \xB7 How may we help you?")));
}
function PaperLanding() {
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Nav, null), /*#__PURE__*/React.createElement(Hero, null), /*#__PURE__*/React.createElement(TalkProduct, null), /*#__PURE__*/React.createElement(Features, null), /*#__PURE__*/React.createElement(Team, null), /*#__PURE__*/React.createElement(Contact, null), /*#__PURE__*/React.createElement(Footer, null));
}
Object.assign(window, {
  PaperLanding
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/paper-landing/paper-landing.jsx", error: String((e && e.message) || e) }); }

// ui_kits/paper-landing/placeholders.jsx
try { (() => {
// Netservant × Paper Kit — tasteful pastel placeholders (no external photos).
// "Sugar-paper pastel" abstract art built from Catppuccin Latte radial blobs.

const PSL_PALETTES = {
  gallery: ['teal', 'sky', 'sapphire', 'lavender'],
  ideas: ['peach', 'yellow', 'rosewater', 'flamingo'],
  stats: ['mauve', 'lavender', 'pink', 'blue'],
  design: ['green', 'teal', 'sky', 'yellow'],
  product: ['sapphire', 'lavender', 'mauve', 'sky'],
  hero: ['mauve', 'sapphire', 'teal', 'peach']
};
function blobBg(keys) {
  const v = n => `var(--latte-${n})`;
  const [a, b, c, d] = keys;
  return [`radial-gradient(40% 55% at 18% 28%, color-mix(in srgb, ${v(a)} 85%, transparent), transparent 70%)`, `radial-gradient(45% 60% at 82% 22%, color-mix(in srgb, ${v(b)} 80%, transparent), transparent 72%)`, `radial-gradient(50% 55% at 70% 82%, color-mix(in srgb, ${v(c)} 80%, transparent), transparent 70%)`, `radial-gradient(45% 50% at 25% 85%, color-mix(in srgb, ${v(d)} 75%, transparent), transparent 72%)`, `linear-gradient(135deg, var(--latte-crust), var(--latte-mantle))`].join(', ');
}

// Rectangular photo placeholder. `seed` picks a palette; `label` optional.
function Photo({
  seed = 'product',
  radius = 'var(--radius-paper)',
  height = '100%',
  label,
  icon,
  style = {}
}) {
  const keys = PSL_PALETTES[seed] || PSL_PALETTES.product;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: '100%',
      height,
      minHeight: 160,
      borderRadius: radius,
      overflow: 'hidden',
      background: blobBg(keys),
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      inset: 0,
      background: 'radial-gradient(120% 120% at 50% 0%, transparent 40%, color-mix(in srgb, var(--latte-text) 10%, transparent))'
    }
  }), label || icon ? /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 16,
      bottom: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      color: 'rgba(255,255,255,0.92)',
      fontFamily: 'var(--font-mono)',
      fontSize: 11,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      textShadow: '0 1px 4px rgba(76,79,105,0.4)'
    }
  }, icon ? /*#__PURE__*/React.createElement("i", {
    className: `codicon codicon-${icon}`,
    style: {
      fontSize: 14
    }
  }) : null, label) : null);
}

// Circular avatar placeholder with initials.
function Avatar({
  seed = 'product',
  initials = '',
  style = {}
}) {
  const keys = PSL_PALETTES[seed] || PSL_PALETTES.stats;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: `linear-gradient(135deg, var(--latte-${keys[0]}), var(--latte-${keys[2]}))`,
      color: 'rgba(255,255,255,0.95)',
      fontFamily: 'var(--font-serif)',
      fontSize: 36,
      letterSpacing: '0.02em',
      textShadow: '0 1px 6px rgba(76,79,105,0.35)',
      ...style
    }
  }, initials);
}
Object.assign(window, {
  Photo,
  Avatar,
  PSL_PALETTES
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/paper-landing/placeholders.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Swatch = __ds_scope.Swatch;

__ds_ns.Tok = __ds_scope.Tok;

__ds_ns.CodeBlock = __ds_scope.CodeBlock;

__ds_ns.CommandBox = __ds_scope.CommandBox;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.ContactForm = __ds_scope.ContactForm;

__ds_ns.FeatureItem = __ds_scope.FeatureItem;

__ds_ns.PaperButton = __ds_scope.PaperButton;

__ds_ns.PaperCard = __ds_scope.PaperCard;

__ds_ns.TeamCard = __ds_scope.TeamCard;

})();
