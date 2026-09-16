"""
Headless Blender asset builder for Superhero Battle Simulator.

    blender --background --python tools/blender/build_assets.py

Outputs (glTF binary, vertex-coloured, no textures, no skins):

    public/assets/characters/<archetype>.glb   low-poly humanoids split into named rig
                                        parts (hips/torso/upperArmL/...) so the
                                        engine can pose them rigid-part style —
                                        exactly how PS2-era character animation
                                        was done, and free of skinning cost.
    public/assets/props/props.glb              street furniture: streetlight, car,
                                        hydrant, tree, traffic light, bench,
                                        planter, rubble pile, monument.

Conventions
    * metres, Blender Z-up; exporter converts to glTF Y-up
    * the character faces Blender -Y, which becomes +Z in three.js
    * every part's origin sits on its joint, so rotations pivot correctly
    * vertex colours are flat per face and exported as COLOR_0
"""

import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHAR_DIR = os.path.join(ROOT, "public", "assets", "characters")
PROP_DIR = os.path.join(ROOT, "public", "assets", "props")


# --------------------------------------------------------------- utilities --
def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def make_material(name="SBSVertexColor"):
    """Lambert-ish material that reads the colour attribute (so COLOR_0 exports)."""
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    for n in list(nodes):
        nodes.remove(n)
    out = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    attr = nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    mat.node_tree.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


class Part:
    """Accumulates flat-shaded primitives in joint-local space."""

    def __init__(self, name, parent, location=(0, 0, 0)):
        self.name = name
        self.parent = parent
        self.location = Vector(location)
        self.verts = []
        self.faces = []
        self.colors = []
        self.obj = None

    # -- primitives ---------------------------------------------------------
    def _add(self, verts, faces, color):
        base = len(self.verts)
        self.verts.extend(verts)
        for f in faces:
            self.faces.append([base + i for i in f])
            self.colors.append(color)

    def box(self, center, size, color, taper=1.0, taper_axis=2, shear=(0.0, 0.0)):
        cx, cy, cz = center
        sx, sy, sz = size
        hx, hy, hz = sx / 2, sy / 2, sz / 2
        v = []
        for iz, sz_sign in ((0, -1), (1, 1)):
            t = taper if sz_sign > 0 else 1.0
            # shear only applies to the top ring
            shx = shear[0] if sz_sign > 0 else 0.0
            shy = shear[1] if sz_sign > 0 else 0.0
            for ix, sx_sign in ((0, -1), (1, 1)):
                for iy, sy_sign in ((0, -1), (1, 1)):
                    v.append(
                        Vector(
                            (
                                cx + sx_sign * hx * t + shx,
                                cy + sy_sign * hy * t + shy,
                                cz + sz_sign * hz,
                            )
                        )
                    )
        # index: [z][x][y]
        f = [
            [0, 1, 3, 2],  # bottom
            [4, 6, 7, 5],  # top
            [0, 2, 6, 4],  # -x
            [1, 5, 7, 3],  # +x
            [0, 4, 5, 1],  # -y
            [2, 3, 7, 6],  # +y
        ]
        self._add(v, f, color)

    def cyl(self, center, r, h, color, n=8, axis="Z", r_top=None, cap=True):
        cx, cy, cz = center
        r_top = r if r_top is None else r_top
        ring_bottom = []
        ring_top = []
        for i in range(n):
            a = (i / n) * math.tau
            ca, sa = math.cos(a), math.sin(a)
            if axis == "Z":
                ring_bottom.append(Vector((cx + ca * r, cy + sa * r, cz - h / 2)))
                ring_top.append(Vector((cx + ca * r_top, cy + sa * r_top, cz + h / 2)))
            elif axis == "Y":
                ring_bottom.append(Vector((cx + ca * r, cy - h / 2, cz + sa * r)))
                ring_top.append(Vector((cx + ca * r_top, cy + h / 2, cz + sa * r_top)))
            else:
                ring_bottom.append(Vector((cx - h / 2, cy + ca * r, cz + sa * r)))
                ring_top.append(Vector((cx + h / 2, cy + ca * r_top, cz + sa * r_top)))
        verts = ring_bottom + ring_top
        faces = []
        for i in range(n):
            j = (i + 1) % n
            faces.append([i, j, n + j, n + i])
        if cap:
            faces.append(list(reversed(range(n))))
            faces.append([n + i for i in range(n)])
        self._add(verts, faces, color)

    def sphere(self, center, r, color, seg=8, rings=5, squash=1.0):
        cx, cy, cz = center
        verts = []
        faces = []
        for j in range(1, rings):
            phi = math.pi * j / rings
            for i in range(seg):
                th = math.tau * i / seg
                verts.append(
                    Vector(
                        (
                            cx + r * math.sin(phi) * math.cos(th),
                            cy + r * math.sin(phi) * math.sin(th),
                            cz + r * math.cos(phi) * squash,
                        )
                    )
                )
        top = len(verts)
        verts.append(Vector((cx, cy, cz + r * squash)))
        bottom = len(verts)
        verts.append(Vector((cx, cy, cz - r * squash)))
        for j in range(rings - 2):
            for i in range(seg):
                a = j * seg + i
                b = j * seg + (i + 1) % seg
                c = (j + 1) * seg + (i + 1) % seg
                d = (j + 1) * seg + i
                faces.append([a, b, c, d])
        for i in range(seg):
            faces.append([top, (i + 1) % seg, i])
            base = (rings - 2) * seg
            faces.append([bottom, base + i, base + (i + 1) % seg])
        self._add(verts, faces, color)

    def plate(self, center, size, color, tilt=(0.0, 0.0)):
        """Flat tapered plate — capes, emblems, signs."""
        self.box(center, size, color, taper=0.75, shear=tilt)

    # -- realisation --------------------------------------------------------
    def build(self, material):
        if not self.verts:
            return None
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        mesh.validate()
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        obj.location = self.location
        bpy.context.collection.objects.link(obj)

        attr = mesh.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
        li = 0
        for fi, poly in enumerate(mesh.polygons):
            poly.use_smooth = False
            c = self.colors[fi]
            # Cheap top-down ambient bake: up-facing faces catch the sky, down-
            # facing faces fall into shadow. Gives the flat-shaded body form even
            # under flat engine lighting.
            k = 0.80 + 0.26 * (poly.normal.z * 0.5 + 0.5)
            r = min(1.0, c[0] * k)
            g = min(1.0, c[1] * k)
            b = min(1.0, c[2] * k)
            for _ in poly.loop_indices:
                attr.data[li].color = (r, g, b, 1.0)
                li += 1

        obj.data.materials.append(material)
        parent_obj = self.parent.obj if isinstance(self.parent, Part) else self.parent
        if parent_obj is not None:
            obj.parent = parent_obj
        self.obj = obj
        return obj


# ------------------------------------------------------------- characters ---
def default_cfg(**over):
    cfg = dict(
        name="hero",
        height=1.85,
        bulk=1.0,          # width multiplier
        head_scale=1.0,
        arm_len=1.0,
        leg_len=1.0,
        skin=(0.83, 0.66, 0.52),
        suit=(0.16, 0.24, 0.62),
        suit_dark=(0.10, 0.15, 0.42),
        accent=(0.92, 0.18, 0.16),
        boots=(0.92, 0.18, 0.16),
        hair=(0.12, 0.10, 0.11),
        metal=(0.62, 0.66, 0.72),
        cape=None,          # colour tuple to enable a cape
        pads=False,
        mask=False,
        ponytail=False,
        glow=None,          # optional emissive-ish accent colour
        eye=(0.92, 0.95, 1.0),
        glove=None,         # defaults to suit_dark
    )
    cfg.update(over)
    return cfg


def build_character(cfg):
    m = make_material()
    h = cfg["height"]
    bulk = cfg["bulk"]

    hip_z = 0.53 * h * cfg["leg_len"]
    torso_len = 0.22 * h
    torso_z = hip_z + torso_len / 2
    shoulder_z = hip_z + torso_len * 0.92
    neck_z = hip_z + torso_len
    head_r = 0.072 * h * cfg["head_scale"]
    head_z = neck_z + head_r * 0.95
    shoulder_x = 0.115 * h * bulk
    hip_x = 0.062 * h * bulk
    chest_w = 0.185 * h * bulk
    chest_d = 0.105 * h * bulk
    pelvis_w = 0.145 * h * bulk
    pelvis_d = 0.095 * h * bulk
    upper_arm = 0.165 * h * cfg["arm_len"]
    lower_arm = 0.15 * h * cfg["arm_len"]
    arm_r = 0.030 * h * (0.9 + 0.5 * bulk)
    upper_leg = 0.235 * h * cfg["leg_len"]
    lower_leg = 0.235 * h * cfg["leg_len"]
    leg_r = 0.040 * h * bulk
    foot_len = 0.10 * h

    root = bpy.data.objects.new("root", None)
    root.empty_display_size = 0.2
    bpy.context.collection.objects.link(root)

    parts = {}
    skin = cfg["skin"]
    suit = cfg["suit"]
    dark = cfg["suit_dark"]
    accent = cfg["accent"]
    boots = cfg["boots"]
    hair = cfg["hair"]
    metal = cfg["metal"]
    eye = cfg["eye"]
    glove = cfg["glove"] or dark

    # --- hips -----------------------------------------------------------
    hips = Part("hips", root, (0, 0, hip_z))
    hips.box((0, 0, 0.012 * h), (pelvis_w, pelvis_d, 0.10 * h), dark, taper=1.02)
    hips.box((0, 0, -0.022 * h), (pelvis_w * 1.06, pelvis_d * 1.06, 0.032 * h), accent)  # belt
    hips.box((0, -pelvis_d * 0.56, -0.022 * h), (0.055 * h, 0.016 * h, 0.030 * h), metal)  # buckle
    for s in (-1, 1):
        # thigh guards
        hips.box((s * hip_x * 1.25, 0, -0.004 * h), (0.05 * h, pelvis_d * 0.95, 0.075 * h), dark, taper=0.82)
    parts["hips"] = hips

    # --- torso ----------------------------------------------------------
    torso = Part("torso", root, (0, 0, hip_z))
    torso.box((0, 0, torso_len * 0.14), (pelvis_w * 1.02, pelvis_d * 1.06, torso_len * 0.34), suit, taper=1.06)
    # chest widens upward; shear gives the classic heroic taper
    torso.box(
        (0, 0, torso_len * 0.55),
        (chest_w, chest_d, torso_len * 0.64),
        suit,
        taper=1.0,
        shear=(0.0, -0.006 * h),
    )
    torso.box((0, 0, torso_len * 0.88), (chest_w * 0.96, chest_d * 0.92, torso_len * 0.22), suit)
    torso.cyl((0, 0, torso_len * 1.0), head_r * 0.52, 0.06 * h, skin)  # neck
    for s in (-1, 1):
        torso.box((s * chest_w * 0.24, -chest_d * 0.52, torso_len * 0.62), (chest_w * 0.44, 0.02 * h, torso_len * 0.30), suit)
    # raised shield emblem
    torso.box((0, -chest_d * 0.56, torso_len * 0.64), (chest_w * 0.34, 0.022 * h, torso_len * 0.34), accent, taper=0.62)
    torso.box((0, -chest_d * 0.6, torso_len * 0.64), (chest_w * 0.18, 0.02 * h, torso_len * 0.18), metal, taper=0.6)
    torso.box((0, chest_d * 0.5, torso_len * 0.6), (chest_w * 0.8, 0.02 * h, torso_len * 0.5), dark)  # back plate
    torso.box((0, 0, torso_len * 1.0), (chest_w * 0.5, chest_d * 0.88, 0.03 * h), dark)  # collar
    if cfg["pads"]:
        for s in (-1, 1):
            torso.box(
                (s * shoulder_x * 0.95, 0, torso_len * 0.9),
                (chest_w * 0.52, chest_d * 1.5, torso_len * 0.32),
                metal,
                taper=0.5,
            )
            torso.box((s * shoulder_x * 1.05, 0, torso_len * 0.78), (chest_w * 0.4, chest_d * 1.3, torso_len * 0.14), accent, taper=0.7)
    parts["torso"] = torso

    # --- head -----------------------------------------------------------
    head = Part("head", torso, (0, 0, neck_z - hip_z))
    head.sphere((0, 0, head_r * 0.98), head_r, skin, seg=10, rings=6, squash=1.06)
    head.box((0, -head_r * 0.32, head_r * 0.42), (head_r * 1.42, head_r * 1.15, head_r * 0.72), skin)  # jaw
    head.sphere((0, 0.004 * h, head_r * 1.12), head_r * 1.06, hair, seg=10, rings=5, squash=0.9)  # cowl/hair
    head.box((0, -head_r * 0.96, head_r * 1.02), (head_r * 1.34, head_r * 0.34, head_r * 0.32), hair)  # brow
    for s in (-1, 1):
        head.box((s * head_r * 0.44, -head_r * 1.0, head_r * 0.92), (head_r * 0.32, head_r * 0.16, head_r * 0.22), eye)
    if cfg["ponytail"]:
        head.box((0, head_r * 1.02, -head_r * 1.0), (head_r * 0.44, head_r * 0.5, head_r * 1.9), hair, taper=0.5)
    if cfg["mask"]:
        head.box((0, -head_r * 1.0, head_r * 0.86), (head_r * 1.3, head_r * 0.34, head_r * 0.62), dark)
    parts["head"] = head

    # --- cape -----------------------------------------------------------
    if cfg["cape"]:
        cape = Part("cape", torso, (0, chest_d * 0.5, torso_len * 0.9))
        cape.box((0, chest_d * 0.22, -torso_len * 0.32), (chest_w * 1.06, 0.03 * h, torso_len * 0.72), cfg["cape"], taper=1.05)
        cape.box(
            (0, chest_d * 0.5, -torso_len * 0.98),
            (chest_w * 1.2, 0.03 * h, torso_len * 0.72),
            cfg["cape"],
            taper=1.12,
            shear=(0.0, 0.04 * h),
        )
        parts["cape"] = cape

    # --- arms -----------------------------------------------------------
    for side, sx in (("L", -1), ("R", 1)):
        ux = sx * shoulder_x
        ua = Part(f"upperArm{side}", torso, (ux, 0, shoulder_z - hip_z))
        ua.sphere((0, 0, -arm_r * 0.2), arm_r * 1.3, suit, seg=8, rings=5)  # deltoid
        ua.cyl((0, 0, -upper_arm * 0.55), arm_r * 1.12, upper_arm * 0.9, suit, n=8, r_top=arm_r * 0.92)
        ua.cyl((0, 0, -0.02 * h), arm_r * 1.32, 0.035 * h, accent, n=8)  # arm band
        ua.sphere((0, 0, -upper_arm), arm_r * 0.95, dark, seg=8, rings=4)  # elbow
        parts[f"upperArm{side}"] = ua

        la = Part(f"lowerArm{side}", ua, (0, 0, -upper_arm))
        la.cyl((0, 0, -lower_arm * 0.5), arm_r * 0.96, lower_arm * 0.94, suit, n=8, r_top=arm_r * 0.78)
        la.cyl((0, 0, -lower_arm * 0.34), arm_r * 1.16, lower_arm * 0.42, metal, n=8, r_top=arm_r * 1.0)  # bracer
        parts[f"lowerArm{side}"] = la

        hand = Part(f"hand{side}", la, (0, 0, -lower_arm))
        hand.box((0, 0, -0.038 * h), (arm_r * 1.7, arm_r * 1.5, 0.072 * h), glove)
        hand.box((sx * arm_r * 1.05, -arm_r * 0.45, -0.02 * h), (arm_r * 0.7, arm_r * 0.72, arm_r * 1.1), glove)  # thumb
        parts[f"hand{side}"] = hand

    # --- legs -----------------------------------------------------------
    for side, sx in (("L", -1), ("R", 1)):
        lx = sx * hip_x
        ul = Part(f"upperLeg{side}", root, (lx, 0, hip_z))
        ul.sphere((0, 0, 0), leg_r * 1.12, dark, seg=8, rings=4)  # hip
        ul.cyl((0, 0, -upper_leg * 0.5), leg_r * 1.05, upper_leg * 0.94, dark, n=8, r_top=leg_r * 0.86)
        ul.sphere((0, 0, -upper_leg), leg_r * 0.9, dark, seg=8, rings=4)  # knee
        parts[f"upperLeg{side}"] = ul

        ll = Part(f"lowerLeg{side}", ul, (0, 0, -upper_leg))
        ll.cyl((0, 0, -lower_leg * 0.5), leg_r * 0.98, lower_leg * 0.94, boots, n=8, r_top=leg_r * 0.74)
        ll.box((0, -leg_r * 0.85, -lower_leg * 0.1), (leg_r * 1.8, leg_r * 0.7, leg_r * 1.5), metal)  # knee pad
        ll.cyl((0, 0, -lower_leg * 0.96), leg_r * 1.05, 0.03 * h, accent, n=8)  # boot cuff
        parts[f"lowerLeg{side}"] = ll

        ft = Part(f"foot{side}", ll, (0, 0, -lower_leg))
        ft.box((0, -foot_len * 0.22, -0.03 * h), (leg_r * 2.3, foot_len * 0.98, 0.058 * h), boots)
        ft.box((0, -foot_len * 0.52, -0.05 * h), (leg_r * 2.05, foot_len * 0.55, 0.048 * h), boots, taper=0.9)  # toe
        ft.box((0, -foot_len * 0.24, -0.062 * h), (leg_r * 2.45, foot_len * 1.04, 0.02 * h), dark)  # sole
        parts[f"foot{side}"] = ft

    for name, part in parts.items():
        part.build(m)
    return list(parts.values())


ARCHETYPES = {
    # flying brick — the "ram through a building" fantasy
    "aegis": default_cfg(
        name="aegis",
        height=1.92,
        bulk=1.12,
        suit=(0.24, 0.36, 0.92),
        suit_dark=(0.16, 0.24, 0.62),
        accent=(0.94, 0.72, 0.16),
        boots=(0.86, 0.13, 0.12),
        hair=(0.10, 0.09, 0.10),
        cape=(0.84, 0.11, 0.12),
        hair_is_cowl=True,
    ),
    # brick brawler — huge, heavy, ground-pound
    "titan": default_cfg(
        name="titan",
        height=2.62,
        bulk=1.62,
        head_scale=0.82,
        arm_len=1.18,
        leg_len=0.92,
        skin=(0.42, 0.68, 0.30),
        suit=(0.32, 0.28, 0.34),
        suit_dark=(0.22, 0.20, 0.24),
        accent=(0.66, 0.62, 0.30),
        boots=(0.28, 0.24, 0.28),
        hair=(0.14, 0.26, 0.12),
        mask=False,
    ),
    # armoured energy projector
    "volt": default_cfg(
        name="volt",
        height=1.86,
        bulk=1.05,
        suit=(0.88, 0.30, 0.22),
        suit_dark=(0.42, 0.16, 0.14),
        accent=(0.35, 0.92, 1.0),
        boots=(0.66, 0.18, 0.14),
        metal=(0.70, 0.73, 0.78),
        hair=(0.20, 0.20, 0.22),
        pads=True,
        mask=True,
    ),
    # amazon warrior — agile, shield/bracelet fantasy
    "amazon": default_cfg(
        name="amazon",
        height=1.80,
        bulk=0.94,
        suit=(0.30, 0.40, 0.82),
        suit_dark=(0.20, 0.26, 0.56),
        accent=(0.95, 0.78, 0.22),
        boots=(0.88, 0.16, 0.14),
        hair=(0.16, 0.10, 0.08),
        metal=(0.80, 0.82, 0.86),
        ponytail=True,
    ),
}


# ------------------------------------------------------------------ props ---
def build_props():
    m = make_material()
    objs = []

    def new(name, parent=None):
        p = Part(name, parent)
        objs.append(p)
        return p

    concrete = (0.62, 0.61, 0.57)
    dark_metal = (0.24, 0.25, 0.28)
    steel = (0.46, 0.48, 0.52)
    glass = (0.55, 0.72, 0.80)

    p = new("streetlight")
    p.cyl((0, 0, 4.2), 0.11, 8.4, dark_metal, n=8, r_top=0.075)
    p.box((0, -0.9, 8.35), (0.16, 1.9, 0.14), dark_metal)
    p.box((0, -1.75, 8.2), (0.5, 0.9, 0.22), steel, taper=0.9)
    p.box((0, -1.75, 8.06), (0.42, 0.78, 0.08), (1.0, 0.92, 0.6))

    p = new("trafficlight")
    p.cyl((0, 0, 3.6), 0.09, 7.2, dark_metal, n=8)
    p.box((0, 0, 7.5), (0.34, 0.34, 0.95), (0.22, 0.23, 0.2))
    p.box((0, -0.2, 7.75), (0.2, 0.12, 0.2), (0.9, 0.2, 0.15))
    p.box((0, -0.2, 7.45), (0.2, 0.12, 0.2), (0.9, 0.75, 0.2))
    p.box((0, -0.2, 7.15), (0.2, 0.12, 0.2), (0.25, 0.8, 0.35))

    p = new("hydrant")
    p.cyl((0, 0, 0.34), 0.16, 0.68, (0.72, 0.18, 0.16), n=8)
    p.cyl((0, 0, 0.72), 0.11, 0.16, (0.62, 0.15, 0.14), n=8)
    p.box((0, 0, 0.5), (0.5, 0.16, 0.14), (0.66, 0.16, 0.15))

    p = new("tree")
    p.cyl((0, 0, 1.5), 0.17, 3.0, (0.32, 0.24, 0.17), n=6, r_top=0.12)
    p.sphere((0, 0, 3.6), 1.35, (0.24, 0.42, 0.20), seg=7, rings=4, squash=0.95)
    p.sphere((0.7, 0.4, 3.1), 0.95, (0.20, 0.36, 0.17), seg=6, rings=3, squash=0.9)
    p.sphere((-0.6, -0.5, 3.2), 0.85, (0.27, 0.46, 0.22), seg=6, rings=3, squash=0.9)

    p = new("car")
    body = (0.30, 0.36, 0.62)
    p.box((0, 0, 0.62), (1.85, 4.4, 0.62), body)
    p.box((0, -0.16, 1.06), (1.62, 2.3, 0.52), body, taper=0.86)
    p.box((0, -0.16, 1.08), (1.5, 2.1, 0.4), glass, taper=0.92)
    p.box((0, -2.2, 0.55), (1.7, 0.24, 0.34), (0.2, 0.2, 0.22))
    p.box((0, 2.2, 0.62), (1.7, 0.24, 0.34), (0.2, 0.2, 0.22))
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.cyl((sx * 0.92, sy * 1.42, 0.36), 0.36, 0.28, (0.11, 0.11, 0.12), n=8, axis="X")
    p.box((-0.66, -2.05, 0.66), (0.34, 0.12, 0.2), (1.0, 0.95, 0.7))
    p.box((0.66, -2.05, 0.66), (0.34, 0.12, 0.2), (1.0, 0.95, 0.7))

    p = new("bench")
    p.box((0, 0, 0.44), (0.58, 2.0, 0.09), (0.42, 0.28, 0.17))
    p.box((0, 0.98, 0.68), (0.58, 0.09, 0.5), (0.42, 0.28, 0.17))
    for sy in (-1, 1):
        p.box((0, sy * 0.85, 0.22), (0.5, 0.1, 0.44), dark_metal)

    p = new("planter")
    p.box((0, 0, 0.34), (1.5, 1.5, 0.7), concrete, taper=1.0)
    p.box((0, 0, 0.66), (1.24, 1.24, 0.1), (0.24, 0.2, 0.14))
    p.sphere((0, 0, 0.95), 0.6, (0.26, 0.44, 0.22), seg=6, rings=3, squash=0.7)

    p = new("rubble_a")
    p.box((0, 0, 0.35), (1.5, 1.1, 0.7), concrete, taper=0.8, shear=(0.15, 0.1))

    p = new("rubble_b")
    p.box((0, 0, 0.3), (1.1, 1.4, 0.6), (0.5, 0.49, 0.46), taper=0.9)
    p.box((0.5, 0.2, 0.75), (0.6, 0.7, 0.4), concrete, taper=0.7)

    p = new("monument")
    p.cyl((0, 0, 0.5), 2.4, 1.0, (0.7, 0.69, 0.66), n=10)
    p.cyl((0, 0, 1.4), 1.6, 0.8, (0.66, 0.65, 0.62), n=10)
    p.box((0, 0, 4.2), (0.7, 0.7, 5.4), (0.72, 0.71, 0.68), taper=0.35)
    p.sphere((0, 0, 7.4), 0.62, (0.86, 0.7, 0.2), seg=6, rings=4)

    made = [part.build(m) for part in objs]
    return made


# ------------------------------------------------------------------ export --
def export(path, objs):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    resolved = [o.obj if isinstance(o, Part) else o for o in objs]
    for o in resolved:
        if o:
            o.select_set(True)
    bpy.context.view_layer.objects.active = resolved[0]
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_normals=True,
        export_texcoords=False,
        export_vertex_color="MATERIAL",
        export_all_vertex_colors=True,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
        export_materials="EXPORT",
        export_draco_mesh_compression_enable=False,
    )
    print(f"  wrote {path}")


def stats(objs):
    tris = 0
    for o in objs:
        o = o.obj if isinstance(o, Part) else o
        if not o or o.type != "MESH":
            continue
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    return tris


def main():
    print("== SBS asset build ==")
    for name, cfg in ARCHETYPES.items():
        reset_scene()
        objs = build_character(cfg)
        tris = stats(objs)
        export(os.path.join(CHAR_DIR, f"{name}.glb"), objs)
        print(f"  {name}: {len(objs)} parts, {tris} tris")

    reset_scene()
    props = build_props()
    tris = stats(props)
    export(os.path.join(PROP_DIR, "props.glb"), props)
    print(f"  props: {len(props)} objects, {tris} tris")
    print("== done ==")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # pragma: no cover - CLI feedback
        import traceback

        traceback.print_exc()
        sys.exit(1)
