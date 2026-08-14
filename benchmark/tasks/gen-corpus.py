import json
from pathlib import Path

LIBS_DOCS = {
 "requests":"https://requests.readthedocs.io/en/latest/api/",
 "httpx":"https://www.python-httpx.org/api/",
 "pyyaml":"https://pyyaml.org/wiki/PyYAMLDocumentation",
 "beautifulsoup4":"https://www.crummy.com/software/BeautifulSoup/bs4/doc/",
 "rich":"https://rich.readthedocs.io/en/stable/introduction.html",
 "click":"https://click.palletsprojects.com/en/stable/",
 "pandas":"https://pandas.pydata.org/docs/",
 "sqlalchemy":"https://docs.sqlalchemy.org/en/latest/orm/session.html",
 "fastapi":"https://fastapi.tiangolo.com/tutorial/first-steps/",
 "redis-py":"https://redis-py.readthedocs.io/en/stable/",
 "axios":"https://axios-http.com/docs/req_config",
 "express":"https://expressjs.com/en/4x/api.html",
 "fs/promises":"https://nodejs.org/api/fs.html",
 "zod":"https://zod.dev/",
 "http":"https://nodejs.org/api/http.html",
 "net/http":"https://pkg.go.dev/net/http",
 "kubernetes-client":"https://github.com/kubernetes-client/python",
 "ansible.builtin.debug":"https://docs.ansible.com/ansible/latest/collections/ansible/builtin/debug_module.html",
 "ansible.builtin.copy":"https://docs.ansible.com/ansible/latest/collections/ansible/builtin/copy_module.html",
 "jinja2":"https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_filters.html",
}
L3="Level 3: Dependency/API usage"; L4="Level 4: Framework integration"; L5="Level 5: Infrastructure / architecture"

# (lang, level, lib, request, fact_prefix)
rows = [
 ("Python",L3,"requests","Add get_status_code(url) using requests.get → HTTP status code","Add get_status_code"),
 ("Python",L3,"httpx","Add get_status_code(url) using httpx.get → HTTP status code","Add get_status_code"),
 ("Python",L3,"pyyaml","Add load_config(text) using yaml.safe_load → parsed dict","Add load_config"),
 ("Python",L3,"beautifulsoup4","Add first_title(html) using bs4 BeautifulSoup → title string","Add first_title"),
 ("Python",L3,"rich","Add render(text) using rich Console(record=True) → captured text","Add render"),
 ("Python",L3,"click","Add main(name) using click command → echoes greeting","Add main"),
 ("Python",L3,"pandas","Add count_rows(rows) using pandas → row count int","Add count_rows"),
 ("Python",L4,"sqlalchemy","Add insert_user(session,name)+select using sqlalchemy ORM","Add insert_user"),
 ("Python",L4,"fastapi","Add GET /health endpoint returning {\"status\":\"ok\"} using fastapi","Add GET /health"),
 ("Python",L4,"redis-py","Add get_set(client,key,val) roundtrip using redis-py","Add get_set"),
 ("TypeScript",L3,"axios","Add getStatus(url) using axios.get → number","Add getStatus"),
 ("TypeScript",L3,"express","Create express app with GET /ping → 'pong'","Create express app"),
 ("TypeScript",L3,"fs/promises","Add readJson(path) using fs/promises → parsed JSON","Add readJson"),
 ("TypeScript",L3,"zod","Add validateUser(user) using zod → boolean","Add validateUser"),
 ("TypeScript",L3,"http","Add createServer(port) using http → starts listener","Add createServer"),
 ("TypeScript",L4,"express","Add middleware that adds X-Header to responses","Add middleware"),
 ("TypeScript",L4,"axios","Add fetchWithRetry(url,retries) → promise","Add fetchWithRetry"),
 ("TypeScript",L4,"fs/promises","Add listDirMd(path) listing markdown files","Add listDirMd"),
 ("TypeScript",L4,"zod","Add schema for a Task object with id,request,status","Add Task schema"),
 ("TypeScript",L4,"axios","Add parallelFetch(urls) → array of statuses","Add parallelFetch"),
 ("Go",L3,"net/http","Add getStatus(url) using net/http GET → int","Add getStatus"),
 ("Go",L3,"net/http","Add sum(a,b) with a goroutine example","Add sum"),
 ("Go",L3,"net/http","Add reverse(s) string reversal handling runes","Add reverse"),
 ("Go",L3,"net/http","Add fetchJSON(url) → decoded map","Add fetchJSON"),
 ("Go",L3,"net/http","Add concurrentFetch(urls) using goroutines+channels","Add concurrentFetch"),
 ("Go",L4,"net/http","Add a JSON mux endpoint /echo that returns body","Add /echo"),
 ("Go",L4,"net/http","Add retry(fn, retries) generic helper","Add retry"),
 ("Go",L4,"net/http","Add middleware logging request method+path","Add logging middleware"),
 ("Go",L4,"net/http","Add graceful server shutdown with context","Add graceful shutdown"),
 ("Go",L5,"net/http","Add an http.Server with ReadHeaderTimeout+TLS config","Add TLS server"),
("Go",L5,"net/http","Add a graceful restart signal handler (SIGHUP) wiring","Add SIGHUP reload"),
 ("Kubernetes",L3,"kubernetes-client","Add a Deployment manifest with 3 replicas via k8s client","Add Deployment"),
 ("Kubernetes",L3,"kubernetes-client","Add a Service manifest with NodePort target","Add Service"),
 ("Kubernetes",L3,"kubernetes-client","Add a ConfigMap with two data keys via k8s client","Add ConfigMap"),
 ("Kubernetes",L4,"kubernetes-client","Add an Ingress manifest via networking.k8s.io","Add Ingress"),
 ("Kubernetes",L4,"kubernetes-client","Add a PodDisruptionBudget via k8s client","Add PodDisruptionBudget"),
 ("Kubernetes",L4,"kubernetes-client","Add a Secret with base64-encoded data","Add Secret"),
 ("Kubernetes",L4,"kubernetes-client","Add a StatefulSet with 2 replicas","Add StatefulSet"),
 ("Kubernetes",L5,"kubernetes-client","Add a CronJob manifest scheduled hourly","Add CronJob"),
 ("Kubernetes",L5,"kubernetes-client","Add a HorizontalPodAutoscaler for a Deployment","Add HPA"),
 ("Ansible",L3,"ansible.builtin.debug","Add a playbook task using debug to print a fact variable","Add debug fact"),
 ("Ansible",L3,"ansible.builtin.copy","Add a role with tasks/main.yml using copy module","Add copy role"),
 ("Ansible",L3,"jinja2","Add a Jinja2 template (config.j2) rendered into a file","Add jinja template"),
 ("Ansible",L3,"ansible.builtin.debug","Add a playbook with when: conditional on a hostvar","Add when conditional"),
 ("Ansible",L4,"ansible.builtin.copy","Add an inventory host_vars entry with a list var","Add host_vars"),
 ("Ansible",L4,"jinja2","Add a playbook using a Jinja2 |default filter","Add default filter"),
 ("Ansible",L4,"ansible.builtin.debug","Add a handler notified by a task","Add handler"),
 ("Ansible",L5,"ansible.builtin.copy","Add a playbook collecting_facts and a setup gather","Add setup gather"),
 ("Ansible",L5,"jinja2","Add a Jinja2 template rendering a multi-doc YAML value","Add yaml template"),
 ("Ansible",L5,"ansible.builtin.debug","Add a playbook using delegate_to to localhost","Add delegate_to"),
]
assert len(rows)==50, len(rows)
corpus=[]
for i,(lang,lvl,lib,req,fact) in enumerate(rows):
    n=23+i
    corpus.append({"id":f"T{n:03d}","language":lang,"level":lvl,"lib":lib,"request":req,
                   "research_facts":fact,"official_doc":LIBS_DOCS.get(lib,"https://example.org")})
from collections import Counter
Path("tasks.json").write_text(json.dumps({"count":50,"created":"2026-08-14","spec_ref":"§35/§34/§38","tasks":corpus},indent=2,ensure_ascii=False))
print("tasks:",len(corpus),Counter(r[0] for r in rows))
print("lib check TS:",[t["lib"] for t in corpus if t["language"]=="TypeScript"])
