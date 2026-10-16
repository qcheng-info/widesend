// Shared dismissal keeps only one filter popup open at a time.
(() => {
  const get = (id) => document.getElementById(id);
  const make = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const button = (text, label, action) => {
    const el = make('button', text);
    el.type = 'button';
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', action);
    return el;
  };
  let active;
  function close(restore = false) {
    if (!active) return;
    const { panel, toggle } = active;
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    active = undefined;
    if (restore) toggle.focus();
  }
  function picker(toggle, panel, focus) {
    function open() {
      close();
      panel.hidden = false;
      panel.classList.remove('align-left');
      if (panel.getBoundingClientRect().left < 16) panel.classList.add('align-left');
      toggle.setAttribute('aria-expanded', 'true');
      active = { toggle, panel };
      focus();
    }
    toggle.addEventListener('click', () => (active?.toggle === toggle ? close() : open()));
    toggle.addEventListener('keydown', (event) => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        open();
      }
    });
  }
  document.addEventListener('pointerdown', (event) => {
    if (active && !active.toggle.parentElement.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (active && !active.toggle.parentElement.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      close(true);
    }
  });
  get('filters').addEventListener('submit', () => close());

  const statuses = [
    ['', 'All activity'],
    ['waiting', 'Waiting'],
    ['transferring', 'In progress'],
    ['complete', 'Receiver confirmed'],
    ['error', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['interrupted', 'Unconfirmed / interrupted'],
    ['expired', 'Expired before pairing'],
  ];
  const menu = get('status-menu');
  function focusOption(index) {
    const options = [...menu.children];
    options.forEach((option, i) => (option.tabIndex = i === index ? 0 : -1));
    options[index].focus();
  }
  statuses.forEach(([value, label], index) => {
    const option = button(label, null, () => {
      get('status').value = value;
      get('status-value').textContent = label;
      [...menu.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === index)));
      close(true);
    });
    const check = make('span', '✓', 'option-check');
    check.setAttribute('aria-hidden', 'true');
    option.append(check);
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === 0));
    option.tabIndex = -1;
    option.addEventListener('keydown', (event) => {
      let target;
      if (event.key === 'ArrowDown') target = (index + 1) % statuses.length;
      if (event.key === 'ArrowUp') target = (index + statuses.length - 1) % statuses.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = statuses.length - 1;
      if (event.key.length === 1 && /\S/.test(event.key)) {
        target = statuses.findIndex(
          ([, name], i) => i > index && name.toLowerCase().startsWith(event.key.toLowerCase()),
        );
        if (target < 0)
          target = statuses.findIndex(([, name]) =>
            name.toLowerCase().startsWith(event.key.toLowerCase()),
          );
      }
      if (target !== undefined && target >= 0) {
        event.preventDefault();
        focusOption(target);
      }
    });
    menu.append(option);
  });
  picker(get('status-toggle'), menu, () =>
    focusOption(statuses.findIndex(([value]) => value === get('status').value)),
  );

  // UTC throughout: displayed dates and submitted filters refer to the same day.
  const iso = (date) => date.toISOString().slice(0, 10);
  const today = () => new Date(`${iso(new Date())}T00:00:00Z`);
  const monthLabel = new Intl.DateTimeFormat('en', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const dayLabel = new Intl.DateTimeFormat('en', { dateStyle: 'full', timeZone: 'UTC' });
  function shiftMonth(date, delta) {
    const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(date.getUTCDate(), last));
    return next;
  }
  for (const id of ['from', 'to']) {
    const panel = get(`${id}-calendar`);
    let focused = today();
    function choose(date) {
      get(id).value = date ? iso(date) : '';
      const label = get(`${id}-value`);
      label.textContent = date ? iso(date) : 'Any date';
      label.classList.toggle('placeholder', !date);
      close(true);
    }
    const heading = make('div', undefined, 'calendar-heading');
    const title = make('span');
    title.id = `${id}-month`;
    title.setAttribute('aria-live', 'polite');
    const previous = button('‹', 'Previous month', () => {
      focused = shiftMonth(focused, -1);
      render();
    });
    const next = button('›', 'Next month', () => {
      focused = shiftMonth(focused, 1);
      render();
    });
    heading.append(previous, title, next);
    const grid = make('div', undefined, 'calendar-grid');
    grid.setAttribute('role', 'grid');
    grid.setAttribute('aria-labelledby', title.id);
    const footer = make('div', undefined, 'calendar-footer');
    footer.append(
      button('Clear', 'Clear date', () => choose(null)),
      button('Today', 'Choose today (UTC)', () => choose(today())),
    );
    panel.append(heading, grid, footer);
    function render(focusDay = false) {
      title.textContent = monthLabel.format(focused);
      grid.replaceChildren();
      const weekdays = make('div', undefined, 'calendar-week');
      weekdays.setAttribute('role', 'row');
      for (const name of ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']) {
        const cell = make('span', name);
        cell.setAttribute('role', 'columnheader');
        weekdays.append(cell);
      }
      grid.append(weekdays);
      const start = new Date(Date.UTC(focused.getUTCFullYear(), focused.getUTCMonth(), 1));
      start.setUTCDate(1 - start.getUTCDay());
      for (let week = 0; week < 6; week++) {
        const row = make('div', undefined, 'calendar-week');
        row.setAttribute('role', 'row');
        for (let day = 0; day < 7; day++) {
          const date = new Date(start);
          date.setUTCDate(start.getUTCDate() + week * 7 + day);
          const value = iso(date);
          const cell = make('div');
          cell.setAttribute('role', 'gridcell');
          cell.setAttribute('aria-selected', String(value === get(id).value));
          const item = button(String(date.getUTCDate()), dayLabel.format(date), () => choose(date));
          item.className = 'calendar-day';
          item.classList.toggle('outside-month', date.getUTCMonth() !== focused.getUTCMonth());
          if (value === iso(today())) item.setAttribute('aria-current', 'date');
          item.tabIndex = value === iso(focused) ? 0 : -1;
          item.addEventListener('keydown', (event) => {
            const offsets = {
              ArrowLeft: -1,
              ArrowRight: 1,
              ArrowUp: -7,
              ArrowDown: 7,
              Home: -date.getUTCDay(),
              End: 6 - date.getUTCDay(),
            };
            if (event.key in offsets) {
              focused = new Date(date);
              focused.setUTCDate(date.getUTCDate() + offsets[event.key]);
            } else if (event.key === 'PageUp' || event.key === 'PageDown') {
              focused = shiftMonth(
                date,
                (event.key === 'PageUp' ? -1 : 1) * (event.shiftKey ? 12 : 1),
              );
            } else return;
            event.preventDefault();
            render(true);
          });
          item.addEventListener('focus', () => {
            focused = new Date(date);
            grid.querySelectorAll('button').forEach((el) => (el.tabIndex = el === item ? 0 : -1));
          });
          cell.append(item);
          row.append(cell);
        }
        grid.append(row);
      }
      if (focusDay) grid.querySelector('[tabindex="0"]').focus();
    }
    picker(get(`${id}-toggle`), panel, () => {
      focused = get(id).value ? new Date(`${get(id).value}T00:00:00Z`) : today();
      render(true);
    });
  }
})();
