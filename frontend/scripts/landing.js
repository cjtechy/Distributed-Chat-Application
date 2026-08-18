(function () {
  "use strict";

  function hidePageLoader() {
    var loader = document.getElementById("loader");
    if (!loader || loader.dataset.dismissed === "1") return;
    loader.dataset.dismissed = "1";
    setTimeout(function () {
      loader.style.transition = "opacity 0.6s ease-out";
      loader.style.opacity = "0";
      setTimeout(function () {
        loader.style.display = "none";
      }, 600);
    }, 900);
  }

  if (document.readyState === "complete") hidePageLoader();
  else window.addEventListener("load", hidePageLoader);
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) hidePageLoader();
  });

  document.querySelectorAll(".dc-year").forEach(function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  var scrollProgressBar = document.getElementById("scrollProgressBar");
  var scrollProgressRoot = document.getElementById("scrollProgress");
  function updateScrollProgress() {
    if (!scrollProgressBar) return;
    var doc = document.documentElement;
    var max = doc.scrollHeight - doc.clientHeight;
    var pct = max > 0 ? ((doc.scrollTop || document.body.scrollTop) / max) * 100 : 0;
    scrollProgressBar.style.width = pct + "%";
    if (scrollProgressRoot) {
      scrollProgressRoot.setAttribute("aria-valuenow", String(Math.round(pct)));
    }
  }

  var logos = [
    "Neighborhoods",
    "Clubs",
    "Teams",
    "Classrooms",
    "Congregations",
    "Hobby groups",
    "Study circles",
    "Alumni",
    "Volunteer crews",
    "Local chapters",
  ];
  var logosTrack = document.getElementById("logosTrack");
  if (logosTrack) {
    logos.concat(logos).forEach(function (label) {
      var el = document.createElement("div");
      el.className = "logo-item";
      el.textContent = label;
      logosTrack.appendChild(el);
    });
  }

  var nav = document.getElementById("mainNav");
  window.addEventListener(
    "scroll",
    function () {
      if (nav) nav.classList.toggle("scrolled", window.scrollY > 10);
      updateScrollProgress();
    },
    { passive: true }
  );
  window.addEventListener("load", updateScrollProgress);
  window.addEventListener("resize", updateScrollProgress);
  window.addEventListener("load", function () {
    document.querySelectorAll(".hero-content, .hero-visual").forEach(function (el, i) {
      setTimeout(function () {
        el.classList.add("visible");
      }, i * 150 + 100);
    });
  });

  var hamburger = document.getElementById("hamburger");
  var mobileMenu = document.getElementById("mobileMenu");
  var lockedScrollY = 0;
  if (hamburger && mobileMenu) {
    hamburger.addEventListener("click", function () {
      var open = mobileMenu.classList.contains("open");
      if (open) {
        mobileMenu.classList.remove("open");
        hamburger.classList.remove("open");
        hamburger.setAttribute("aria-expanded", "false");
        document.body.style.position = "";
        document.body.style.top = "";
        window.scrollTo({ top: lockedScrollY, behavior: "instant" });
      } else {
        lockedScrollY = window.scrollY;
        document.body.style.position = "fixed";
        document.body.style.top = "-" + lockedScrollY + "px";
        mobileMenu.classList.add("open");
        hamburger.classList.add("open");
        hamburger.setAttribute("aria-expanded", "true");
      }
    });
    mobileMenu.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        mobileMenu.classList.remove("open");
        hamburger.classList.remove("open");
        hamburger.setAttribute("aria-expanded", "false");
        document.body.style.position = "";
        document.body.style.top = "";
        window.scrollTo({ top: lockedScrollY, behavior: "instant" });
      });
    });
  }

  var stickyCards = document.querySelectorAll(".sticky-card");
  var panelViews = document.querySelectorAll(".panel-view");
  var panelLabel = document.getElementById("panelLabel");
  var panelLabels = ["Live room", "Who's around", "Catch up"];
  stickyCards.forEach(function (card, i) {
    card.addEventListener("click", function (e) {
      if (e.target.closest(".sticky-card-cta")) return;
      stickyCards.forEach(function (c) {
        c.classList.remove("active");
      });
      panelViews.forEach(function (p) {
        p.classList.remove("active");
      });
      card.classList.add("active");
      var panel = document.getElementById("panel-" + i);
      if (panel) panel.classList.add("active");
      if (panelLabel) panelLabel.textContent = panelLabels[i] || card.querySelector("h3").textContent;
    });
  });

  var stickyObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function () {
        stickyCards.forEach(function (card, i) {
          var rect = card.getBoundingClientRect();
          var viewH = window.innerHeight;
          if (rect.top < viewH * 0.6 && rect.bottom > viewH * 0.3) {
            stickyCards.forEach(function (c) {
              c.classList.remove("active");
            });
            panelViews.forEach(function (p) {
              p.classList.remove("active");
            });
            card.classList.add("active");
            var panel = document.getElementById("panel-" + i);
            if (panel) panel.classList.add("active");
            if (panelLabel) panelLabel.textContent = panelLabels[i];
          }
        });
      });
    },
    { threshold: 0.3 }
  );
  stickyCards.forEach(function (c) {
    stickyObserver.observe(c);
  });

  var statNums = document.querySelectorAll(".stat-num[data-target]");
  var statsObs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var el = e.target;
        var target = parseFloat(el.dataset.target);
        var suffix = el.dataset.suffix || "";
        var start = 0;
        var duration = 1800;
        var startTime = null;
        function animate(ts) {
          if (!startTime) startTime = ts;
          var progress = Math.min((ts - startTime) / duration, 1);
          var ease = 1 - Math.pow(1 - progress, 3);
          var n = Math.round(start + (target - start) * ease);
          el.textContent = (n >= 1000 ? n.toLocaleString("en-US") : String(n)) + suffix;
          if (progress < 1) requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
        var block = el.closest(".stat-block");
        var bar = block && block.querySelector(".stat-bar");
        if (bar) {
          setTimeout(function () {
            bar.style.width = bar.dataset.width;
          }, 200);
        }
        statsObs.unobserve(el);
      });
    },
    { threshold: 0.5 }
  );
  statNums.forEach(function (el) {
    statsObs.observe(el);
  });

  var faqList = document.getElementById("faqList");
  if (faqList && faqList.dataset.ready !== "1") {
    faqList.dataset.ready = "1";
    faqList.querySelectorAll(".faq-item .faq-q").forEach(function (q) {
      q.addEventListener("click", function () {
        q.closest(".faq-item").classList.toggle("open");
      });
    });
  }

  var allExpanded = false;
  var faqToggle = document.getElementById("faqToggleAll");
  if (faqToggle) {
    faqToggle.addEventListener("click", function () {
      allExpanded = !allExpanded;
      document.querySelectorAll(".faq-item").forEach(function (el) {
        if (allExpanded) el.classList.add("open");
        else el.classList.remove("open");
      });
      var label = document.getElementById("faqToggleLabel");
      if (label) label.textContent = allExpanded ? "Collapse all" : "Expand all";
      var icon = document.getElementById("faqToggleIcon");
      if (icon) {
        icon.innerHTML = allExpanded
          ? '<line x1="5" y1="12" x2="19" y2="12"/>'
          : '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
      }
    });
  }

  var testimonials = [
    {
      q: "Everyone from the neighborhood is in one room now. Saturday plans actually stick.",
      name: "Maya K.",
      role: "Riverside Community",
      init: "MK",
    },
    {
      q: "We used to bounce between group chats. This is simpler — and we can still catch up after practice.",
      name: "Jordan A.",
      role: "Club captain",
      init: "JA",
    },
    {
      q: "I missed a week of class and the history was still there. No one had to recap in DMs.",
      name: "Sam T.",
      role: "Study group",
      init: "ST",
    },
    {
      q: "Seeing who is online makes it feel like a real place, not another abandoned thread.",
      name: "Chris N.",
      role: "Volunteer crew",
      init: "CN",
    },
  ];
  var testiTrack = document.getElementById("testiTrack");
  if (testiTrack) {
    testimonials.forEach(function (t) {
      var el = document.createElement("div");
      el.className = "testi-card";
      el.innerHTML =
        '<div class="testi-stars">' +
        Array(5)
          .fill(
            '<svg viewBox="0 0 24 24"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>'
          )
          .join("") +
        '</div><p class="testi-quote">"' +
        t.q +
        '"</p><div class="testi-author"><div class="testi-avatar">' +
        t.init +
        "</div><div><div class=\"testi-name\">" +
        t.name +
        '</div><div class="testi-role">' +
        t.role +
        "</div></div></div>";
      testiTrack.appendChild(el);
    });
  }

  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener("click", function (e) {
      var href = a.getAttribute("href");
      if (!href || href === "#") return;
      var target = document.querySelector(href);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
    });
  });

  var revealObs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          revealObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  document.querySelectorAll(".silk-reveal, .silk-reveal-left, .silk-reveal-right").forEach(function (el, i) {
    el.style.animationDelay = (i % 4) * 0.08 + "s";
    revealObs.observe(el);
  });

  document.querySelectorAll(".stat-block").forEach(function (el, i) {
    el.style.opacity = "0";
    el.style.transform = "translateY(20px)";
    el.style.transition =
      "opacity .8s var(--silk) " +
      i * 0.1 +
      "s, transform .8s var(--silk) " +
      i * 0.1 +
      "s, border-color .6s var(--silk), box-shadow .6s var(--silk)";
  });
  var statObs2 = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.style.opacity = "1";
          e.target.style.transform = "translateY(0)";
          statObs2.unobserve(e.target);
        }
      });
    },
    { threshold: 0.2 }
  );
  document.querySelectorAll(".stat-block").forEach(function (el) {
    statObs2.observe(el);
  });

  document.querySelectorAll(".section-title, .section-tag, .section-sub").forEach(function (el) {
    el.style.opacity = "0";
    el.style.transform = "translateY(16px)";
    el.style.transition = "opacity .8s var(--silk), transform .8s var(--silk)";
  });
  var headerObs = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.style.opacity = "1";
          e.target.style.transform = "translateY(0)";
          headerObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.3 }
  );
  document.querySelectorAll(".section-title, .section-tag, .section-sub").forEach(function (el) {
    headerObs.observe(el);
  });

  (function initHeroTypewriter() {
    var line = document.querySelector(".hero-typewriter-line");
    var el = document.querySelector(".hero .typewriter");
    if (!el || !line) return;
    var raw = el.getAttribute("data-words");
    if (!raw) return;
    var words = raw.split(",");
    var CURSOR_PX = 14;
    var MIN_FONT_PX = 18;

    function measureMaxWordWidth(fontPx) {
      var probe = document.createElement("span");
      probe.setAttribute("aria-hidden", "true");
      probe.className = "typewriter";
      probe.style.cssText =
        "position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden;pointer-events:none";
      var base = getComputedStyle(el);
      probe.style.font = base.fontWeight + " " + fontPx + "px " + base.fontFamily;
      probe.style.letterSpacing = base.letterSpacing;
      document.body.appendChild(probe);
      var maxW = 0;
      words.forEach(function (w) {
        probe.textContent = w;
        maxW = Math.max(maxW, probe.offsetWidth);
      });
      document.body.removeChild(probe);
      return maxW;
    }

    function layoutTypewriterSlot() {
      var content = line.closest(".hero-content");
      var maxAllowed = Math.max(200, (content ? content.clientWidth : line.clientWidth) - 4);
      var fontPx = parseFloat(getComputedStyle(line).fontSize) || 40;
      var maxW = measureMaxWordWidth(fontPx);
      if (maxW + CURSOR_PX > maxAllowed && maxW > 0) {
        fontPx = Math.max(MIN_FONT_PX, fontPx * ((maxAllowed - CURSOR_PX) / maxW));
        line.style.setProperty("--typewriter-font-size", fontPx + "px");
        maxW = measureMaxWordWidth(fontPx);
      } else {
        line.style.removeProperty("--typewriter-font-size");
      }
      var slot = Math.min(maxW + CURSOR_PX, maxAllowed);
      line.style.setProperty("--typewriter-slot", slot + "px");
    }

    var resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(layoutTypewriterSlot, 120);
    });
    layoutTypewriterSlot();

    var wordIndex = 0;
    var charIndex = 0;
    var deleting = false;
    function tick() {
      var word = words[wordIndex];
      if (deleting) {
        el.textContent = word.substring(0, charIndex - 1);
        charIndex--;
      } else {
        el.textContent = word.substring(0, charIndex + 1);
        charIndex++;
      }
      var delay = deleting ? 50 : 100;
      if (!deleting && charIndex === word.length) {
        delay = 2000;
        deleting = true;
      } else if (deleting && charIndex === 0) {
        deleting = false;
        wordIndex = (wordIndex + 1) % words.length;
        delay = 500;
      }
      setTimeout(tick, delay);
    }
    tick();
  })();

  var username = localStorage.getItem("username");
  var token = localStorage.getItem("token");
  var isAdmin = localStorage.getItem("is_admin") === "true";
  var adminLink = document.getElementById("admin-link");
  var adminLinkMobile = document.getElementById("admin-link-mobile");
  if (isAdmin) {
    if (adminLink) adminLink.hidden = false;
    if (adminLinkMobile) adminLinkMobile.hidden = false;
  }
  if (token && username) {
    document.querySelectorAll("[data-guest-nav]").forEach(function (el) {
      el.hidden = true;
    });
    var dashboardLink = document.getElementById("dashboard-link");
    var dashboardLinkMobile = document.getElementById("dashboard-link-mobile");
    if (dashboardLink) dashboardLink.hidden = false;
    if (dashboardLinkMobile) dashboardLinkMobile.hidden = false;

    var welcome = document.getElementById("welcome");
    var primaryCtas = document.querySelectorAll("[data-primary-cta]");
    if (welcome) {
      welcome.classList.add("visible");
      welcome.textContent = "";
      welcome.append("Welcome back, ");
      var name = document.createElement("strong");
      name.textContent = username;
      welcome.append(name, ".");
    }
    primaryCtas.forEach(function (cta) {
      cta.setAttribute("href", "/console");
      var label = cta.querySelector(".cta-label");
      if (label) label.textContent = "Open dashboard";
      else cta.textContent = "Dashboard";
    });
  }
})();
