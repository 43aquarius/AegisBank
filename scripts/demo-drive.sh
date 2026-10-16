#!/bin/bash
# ============ 演示视频驱动脚本 v2：页面内打字机动画 ============
# 用法: source scripts/demo-drive.sh

# 慢速打字（每字 175ms，页内动画，bash 阻塞至完成）
slowtype() {
  local text="$1"
  agent-browser eval "(async () => {
    const inp = document.querySelector('input[placeholder*=\"银行业务指令\"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (let i = 1; i <= '$text'.length; i++) {
      setter.call(inp, '$text'.slice(0, i));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 175));
    }
    return 'typed:' + inp.value;
  })()"
}

# 慢速输入验证码（每字 200ms）
slowcode() {
  local code="$1"
  agent-browser eval "(async () => {
    const inp = document.querySelector('input[placeholder*=\"验证码\"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (const ch of '$code') {
      const cur = inp.value + ch;
      setter.call(inp, cur);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
    }
    return 'code-typed';
  })()"
}

# 按回车发送
send() {
  agent-browser eval "(() => {
    const inp = document.querySelector('input[placeholder*=\"银行业务指令\"]');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'sent';
  })()"
}

# 点击「验证并执行」按钮
click_verify() {
  agent-browser find role button click --name "验证并执行" 2>/dev/null || true
}

# 等待回复完成（busy 出现→消失），最多 maxWait 秒
wait_reply() {
  local maxWait=${1:-30}
  local t=0
  while [ $t -lt 4 ]; do
    busy=$(agent-browser eval "!!document.querySelector('.animate-bounce')" 2>/dev/null | tail -1)
    [ "$busy" = "true" ] && break
    sleep 0.5; t=$((t+1))
  done
  t=0
  while [ $t -lt $maxWait ]; do
    busy=$(agent-browser eval "!!document.querySelector('.animate-bounce')" 2>/dev/null | tail -1)
    [ "$busy" = "false" ] && [ $t -gt 1 ] && break
    sleep 1; t=$((t+1))
  done
}

# ---- v2 辅助：操作最后一张验证卡/提取验证码/点击确认 ----
slowcode2() {
  local code="$1"
  agent-browser eval "(async () => {
    const inps = [...document.querySelectorAll('input[placeholder*=\"验证码\"]')];
    const inp = inps[inps.length-1];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (let i = 1; i <= '$code'.length; i++) {
      setter.call(inp, '$code'.slice(0, i));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 210));
    }
    return 'code:' + inp.value;
  })()"
}

getcode() {
  agent-browser eval "(() => {
    const els = [...document.querySelectorAll('span')].filter(s => /^[0-9]{6}$/.test(s.textContent.trim()));
    return els.length ? els[els.length-1].textContent.trim() : 'none';
  })()" | tail -1 | tr -d '"'
}

click_confirm() {
  agent-browser eval "(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('确认执行') && !b.disabled);
    if (btns.length) { btns[btns.length-1].click(); return 'ok'; }
    return 'none';
  })()"
}

click_verify() {
  agent-browser eval "(() => {
    const btns = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('验证并执行') && !b.disabled);
    if (btns.length) { btns[btns.length-1].click(); return 'ok'; }
    return 'none';
  })()"
}
