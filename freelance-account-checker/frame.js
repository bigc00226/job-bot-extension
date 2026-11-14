// The hidden document's side of frame-reader.js: opens and removes the frames it asks for. The frame's
// name carries the job's id, which frame-task.js (this extension's script in the site page) reads.
// The sandbox keeps the page from navigating away from the frame (no allow-top-navigation).
chrome.runtime.onMessage.addListener(message => {
  if (message?.target !== "fac-frame") return;
  if (message.type === "open") {
    const frame = document.createElement("iframe");
    frame.name = `fac-task-${message.id}`;
    frame.dataset.id = message.id;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    // A desktop-sized frame, so the sites draw their normal (PC) header with its badges. This document
    // is never drawn, so the frame only gets that size when its layout is worked out on purpose:
    // without it the page sees a 0×0 screen and shows its phone layout, where the badges are hidden.
    frame.width = "1280";
    frame.height = "900";
    frame.style.cssText = "width:1280px;height:900px;border:0;display:block";
    frame.src = message.url;
    document.body.append(frame);
    const layout = setInterval(() => {
      if (!frame.isConnected) { clearInterval(layout); return; }
      void frame.getBoundingClientRect();
    }, 200);
  }
  if (message.type === "close") document.querySelector(`iframe[data-id="${CSS.escape(message.id)}"]`)?.remove();
});
