// Runs ONLY in browsers that can't run the site's modern scripts (type="module").
// Plain ES5 on purpose. Shows a friendly note instead of a page full of empty loaders.
(function () {
  function show() {
    var box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:99;padding:14px 16px;border-radius:14px;" +
      "background:#fcff52;color:#0b0f00;font:500 15px/1.45 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.4)";
    box.appendChild(document.createTextNode(
      "This browser is too old to load the live data on this page. Open it in Chrome, Safari or Firefox " +
      "(or turn off Opera Mini's data saving) and it will work."));
    document.body.appendChild(box);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show); else show();
})();
