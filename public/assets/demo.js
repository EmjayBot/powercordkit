// Demo inbox data for logged-out visitors (marketing site).
// When the Mail API is unreachable or the visitor isn't a mod, inbox pages
// render THESE SAMPLE ITEMS instead of an empty/locked screen — clearly
// badged as a demo. All write actions are blocked in demo mode (guarded in
// each page via PCKDemo.blocked()), so strangers can never send data to the
// real inbox. Nothing here touches D1.
(function () {
  var items = [
    { id: 'demo-1', server: 'main', type: 'ticket', tag: 'ticket', author: 'mod-bot', title: 'Ticket #128 — spam links in #help', content: 'User posting invite links in #help (thread #ticket-128). Two prior warnings on record.', time: '2h ago', prio: 'high', src: 'discord', by: 'auto-capture', url: '#', assigned: null, archived: 0, notes: [{ by: 'vera', text: 'Warned twice before — check the timeline before acting.' }] },
    { id: 'demo-2', server: 'main', type: 'ticket', tag: 'ticket', author: 'mod-bot', title: 'Raid wave in #media — 12 joins in 1 min', content: 'Possible raid: 12 joins/leaves in #media within a minute. Lockdown plan drafted.', time: '3h ago', prio: 'high', src: 'discord', by: 'auto-capture', url: '#', assigned: 'vera', archived: 0, notes: [] },
    { id: 'demo-3', server: 'forum', type: 'support', tag: 'support', author: 'pixelpilot', title: "Can't verify email for forum account", content: 'Signed up yesterday, never got the verification email. Checked spam. Username: pixelpilot.', time: '5h ago', prio: 'normal', src: 'discourse', by: 'discourse-webhook', url: '#', assigned: null, archived: 0, notes: [] },
    { id: 'demo-4', server: 'main', type: 'idea', tag: 'idea', author: 'juno', title: 'Slowmode 10s in #general after 10pm', content: 'Chat gets chaotic late at night. Propose 10s slowmode 22:00–07:00 on weekdays.', time: '1d ago', prio: 'normal', src: 'discord', by: 'idea-capture', url: '#', assigned: null, archived: 0, notes: [{ by: 'vera', text: 'Good candidate for the roadmap — check the Slowmode planner output first.' }] },
    { id: 'demo-5', server: 'main', type: 'idea', tag: 'idea', author: 'maren', title: 'QOTD channel for lore drops', content: 'A daily question-of-the-day thread to surface old lore. Low effort, high engagement?', time: '2d ago', prio: 'low', src: 'discord', by: 'idea-capture', url: '#', assigned: null, archived: 0, notes: [] },
    { id: 'demo-6', server: 'appeals', type: 'appeal', tag: 'appeal', author: '472819304756123456', title: 'Appeal for ban a1b2c3d4', content: '{"apology":"I didn\'t know ads weren\'t allowed, won\'t happen again","rule_read":true}', time: '2d ago', prio: 'high', src: 'discord', by: 'appeal', url: '#', assigned: null, archived: 0, notes: [] }
  ];
  function banner() {
    return '<span class="pill" style="border-color:rgba(88,101,242,.5);color:#8b96f8">Demo preview — sample data</span> <a href="/api/auth/login" style="font-size:11px;color:#8b96f8">Log in with Discord for the live inbox →</a>';
  }
  window.PCKDemo = {
    items: items,
    banner: banner,
    enter: function () { window.__pckDemo = true; },
    isDemo: function () { return !!window.__pckDemo; },
    // Call first in any mutating handler. Returns true when the action must
    // NOT touch the API (demo mode) — caller just returns.
    blocked: function () {
      if (!window.__pckDemo) return false;
      alert('Demo preview — sample data only. Log in with Discord to use the live inbox.');
      return true;
    }
  };
})();
