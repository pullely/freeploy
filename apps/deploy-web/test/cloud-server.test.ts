// DP-118: what the create-a-cloud-server components compute from the provider's catalogue — the Blade's option labels,
// the filtered lists, the price on the button, the advanced options' summary and Hostinger's plans and templates.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloudRoute,
  cpuVendorInfo,
  digitalOceanAdvancedSummary,
  digitalOceanImageOptions,
  digitalOceanInRegion,
  digitalOceanSelectedPrice,
  digitalOceanSizeOptions,
  hetznerAdvancedSummary,
  hetznerAvailableImages,
  hetznerAvailableNetworks,
  hetznerAvailableServerTypes,
  hetznerBackupSurcharge,
  hetznerImageOptions,
  hetznerLocationOptions,
  hetznerSelectedPrice,
  hetznerServerTypeOptions,
  hostingerAppTemplates,
  hostingerDataCenterOptions,
  hostingerOsTemplates,
  hostingerPriceLabel,
  hostingerPriceOptions,
  hostingerTemplateChoice,
  numberFormat,
  scriptOptions,
  sshKeyOptions,
  vultrAdvancedSummary,
  vultrAvailablePlans,
  vultrPlanOptions,
  vultrRegionOptions,
  vultrSelectedPrice,
} from "../src/lib/cloud-server.ts";

test("the route's type and token", () => {
  assert.deepEqual(cloudRoute("/servers/new/hetzner"), { type: "hetzner", tokenUuid: null });
  assert.deepEqual(cloudRoute("/servers/new/digital-ocean/t1abc/"), { type: "digital-ocean", tokenUuid: "t1abc" });
  assert.equal(cloudRoute("/servers/new/manual"), null);
});

test("number_format()", () => {
  assert.equal(numberFormat("4.5100000000", 2), "4.51");
  assert.equal(numberFormat(1234.5, 2), "1,234.50");
  assert.equal(numberFormat(2048 / 1024, 1), "2.0");
  assert.equal(numberFormat(0.905, 2), "0.91");
});

const serverTypes = [
  { name: "cx22", description: "CX22", cores: 2, memory: 4, disk: 40, architecture: "x86", prices: [{ price_monthly: { gross: "4.5100000000" } }], locations: [{ name: "fsn1", available: true }, { name: "nbg1", available: false }] },
  { name: "cax11", description: "CAX11", cores: 2, memory: 4, disk: 40, architecture: "arm", prices: [{ price_monthly: { gross: "4.2000000000" } }], locations: [{ name: "fsn1" }] },
  { name: "ccx13", cores: 2, memory: 8, architecture: "x86", locations: [{ name: "nbg1", available: true }] },
];

test("ByHetzner: the server types of the location, in stock first, and the Blade's labels", () => {
  assert.deepEqual(hetznerAvailableServerTypes(serverTypes, null), []);
  const nbg1 = hetznerAvailableServerTypes(serverTypes, "nbg1");
  assert.deepEqual(
    nbg1.map((t) => [t.name, t.out_of_stock, t.cpu_vendor_info]),
    [
      ["ccx13", false, "AMD Milan EPYC™"],
      ["cx22", true, "Intel®/AMD"],
    ],
  );
  assert.deepEqual(hetznerServerTypeOptions(nbg1), [
    { value: "ccx13", label: "ccx13 · 2 vCPU · 8 GB RAM · ? GB", disabled: false },
    { value: "cx22", label: "CX22 · 2 vCPU · 4 GB RAM · 40 GB · €4.51/mo · Out of stock", disabled: true },
  ]);
  assert.equal(cpuVendorInfo({ name: "CPX31" }), "AMD EPYC™");
  assert.equal(cpuVendorInfo({ name: "cax21" }), "Ampere®");
  assert.equal(cpuVendorInfo({ name: "x1" }), null);
});

test("ByHetzner: images by the type's architecture, the networks of the zone, the prices and the summary", () => {
  const images = [
    { id: 1, name: "debian-12", description: "Debian 12", architecture: "x86" },
    { id: 2, name: "ubuntu-24.04", architecture: "arm" },
  ];
  assert.equal(hetznerAvailableImages(images, serverTypes, null).length, 2);
  assert.deepEqual(hetznerImageOptions(hetznerAvailableImages(images, serverTypes, "cax11")), [{ value: "2", label: "ubuntu-24.04 · arm" }]);
  const locations = [
    { name: "fsn1", city: "Falkenstein", country: "DE", network_zone: "eu-central" },
    { name: "ash", city: "Ashburn, VA", country: "US", network_zone: "us-east" },
  ];
  assert.deepEqual(hetznerLocationOptions(locations), [
    { value: "fsn1", label: "Falkenstein · DE" },
    { value: "ash", label: "Ashburn, VA · US" },
  ]);
  const networks = [
    { id: 10, name: "eu", subnets: [{ type: "cloud", network_zone: "eu-central" }] },
    { id: 11, name: "us", subnets: [{ type: "server", network_zone: "us-east" }] },
    { id: 12, name: "vswitch", subnets: [{ type: "vswitch", network_zone: "eu-central" }] },
  ];
  assert.deepEqual(hetznerAvailableNetworks(networks, locations, null).map((n) => n.id), [10, 11]);
  assert.deepEqual(hetznerAvailableNetworks(networks, locations, "fsn1").map((n) => n.id), [10]);
  assert.equal(hetznerSelectedPrice(serverTypes, "cx22"), "€4.51");
  assert.equal(hetznerBackupSurcharge(serverTypes, "cx22"), "€0.90");
  assert.equal(hetznerSelectedPrice(serverTypes, "ccx13"), null);
  const base = { sshKeys: [], firewalls: [], networks: [], enableBackups: false, enableIpv4: true, enableIpv6: true, showCloudInit: false, cloudInitScript: "", selectedScript: "" };
  assert.deepEqual(hetznerAdvancedSummary(base), []);
  assert.deepEqual(hetznerAdvancedSummary({ ...base, sshKeys: ["1"], firewalls: ["1", "2"], networks: ["1"], enableBackups: true, enableIpv6: false, showCloudInit: true }), [
    "1 extra SSH key",
    "2 firewalls",
    "1 private network",
    "Backups on",
    "IPv4",
    "Cloud-init",
  ]);
  assert.deepEqual(hetznerAdvancedSummary({ ...base, enableIpv4: false, enableIpv6: false }), ["No public IP"]);
  assert.deepEqual(hetznerAdvancedSummary({ ...base, enableIpv4: false }), ["IPv6"]);
});

test("ByVultr: the plans of the region, the labels, the price and the summary", () => {
  const plans = [
    { id: "vc2-1c-1gb", vcpu_count: 1, ram: 1024, disk: 25, monthly_cost: 5, locations: ["ewr"] },
    { id: "vc2-2c-4gb", vcpu_count: 2, ram: 4096, disk: 80, monthly_cost: 20, locations: [] },
  ];
  assert.deepEqual(vultrAvailablePlans(plans, "ams").map((p) => p.id), ["vc2-2c-4gb"]);
  assert.deepEqual(vultrPlanOptions(plans)[0], { value: "vc2-1c-1gb", label: "vc2-1c-1gb · 1 vCPU · 1.0 GB RAM · 25 GB · $5.00/mo" });
  assert.deepEqual(vultrPlanOptions([{ id: "x" }])[0], { value: "x", label: "x · ? vCPU · ? GB RAM · ? GB" });
  assert.deepEqual(vultrRegionOptions([{ id: "ewr", city: "New Jersey", country: "US" }, { id: "xyz" }]), [
    { value: "ewr", label: "New Jersey · US" },
    { value: "xyz", label: "xyz · xyz" },
  ]);
  assert.equal(vultrSelectedPrice(plans, "vc2-2c-4gb"), "$20.00");
  assert.deepEqual(vultrAdvancedSummary({ sshKeys: ["a", "b"], enableIpv6: false, disablePublicIpv4: true, cloudInitScript: "#cloud-config" }), ["2 extra SSH keys", "IPv6 disabled", "Public IPv4 disabled", "cloud-init"]);
});

test("ByDigitalOcean: the sizes and images of the region, the labels, the price and the summary", () => {
  const sizes = [
    { slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, regions: ["nyc1"] },
    { slug: "s-2vcpu-2gb", memory: 2048, vcpus: 2, price_monthly: 18, regions: ["ams3"] },
  ];
  assert.deepEqual(digitalOceanInRegion(sizes, "ams3").map((x) => x.slug), ["s-2vcpu-2gb"]);
  assert.deepEqual(digitalOceanSizeOptions(sizes).map((o) => o.label), ["s-1vcpu-1gb · 1024 MB RAM · 1 vCPU · 25 GB · $6.00/mo", "s-2vcpu-2gb · 2048 MB RAM · 2 vCPU · $18.00/mo"]);
  assert.deepEqual(digitalOceanImageOptions([{ id: 7, slug: "ubuntu-24-04-x64", distribution: "Ubuntu", name: "24.04 (LTS) x64" }, { id: 8, name: "Custom" }]), [
    { value: "ubuntu-24-04-x64", label: "Ubuntu 24.04 (LTS) x64" },
    { value: "8", label: "Custom" },
  ]);
  assert.equal(digitalOceanSelectedPrice(sizes, "s-1vcpu-1gb"), "$6.00");
  assert.deepEqual(digitalOceanAdvancedSummary({ sshKeys: [], enableIpv6: false, monitoring: false, showCloudInit: false, cloudInitScript: " ", selectedScript: "" }), ["IPv4 only", "Monitoring off"]);
  assert.deepEqual(sshKeyOptions([{ id: 3, fingerprint: "aa:bb" }], "fingerprint"), [{ value: "3", label: "aa:bb" }]);
});

test("ByHostinger: plans by size then period, the price label, the templates and the choice of one", () => {
  const catalog = [
    { id: "hostingercom-vps-kvm4", name: "KVM 4", prices: [{ id: "p4m", currency: "usd", price: 2599, first_period_price: 1299, period: 1, period_unit: "month" }] },
    {
      id: "hostingercom-vps-kvm2",
      name: "KVM 2",
      prices: [
        { id: "p2y", currency: "usd", price: 1199, first_period_price: 699, period: 1, period_unit: "year" },
        { id: "p2m", currency: "usd", price: 1499, period: 1, period_unit: "month" },
      ],
    },
  ];
  const prices = hostingerPriceOptions(catalog);
  assert.deepEqual(prices.map((p) => p.id), ["p2m", "p2y", "p4m"]);
  assert.equal(hostingerPriceLabel(prices[1]!), "KVM 2 — USD 6.99 for 1 year, then USD 11.99");
  assert.equal(hostingerPriceLabel({ ...prices[0]!, period: 12 }), "KVM 2 — USD 14.99 for 12 months, then USD 14.99");
  const templates = [{ id: 1, name: "Ubuntu 24.04 LTS" }, { id: 2, name: "Ubuntu 24.04 with Coolify" }];
  assert.deepEqual(hostingerOsTemplates(templates).map((t) => t.id), [1]);
  assert.deepEqual(hostingerAppTemplates(templates).map((t) => t.id), [2]);
  assert.deepEqual(hostingerTemplateChoice({ os: "1", app: "2" }, "app"), { os: null, app: "2", template: "2" });
  assert.deepEqual(hostingerTemplateChoice({ os: "1", app: "2" }, "os"), { os: "1", app: null, template: "1" });
  assert.deepEqual(hostingerDataCenterOptions([{ id: 9, city: "Vilnius", location: "lt" }, { id: 10, name: "Phoenix" }]), [
    { value: "9", label: "Vilnius · LT" },
    { value: "10", label: "Phoenix" },
  ]);
});

test("the saved scripts' listbox starts with an empty script", () => {
  assert.deepEqual(scriptOptions([{ uuid: "c1", name: "Docker" }]), [
    { value: "", label: "Start with an empty script" },
    { value: "c1", label: "Docker" },
  ]);
});
