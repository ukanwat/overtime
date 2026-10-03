# Getting assets into the project, headlessly

## Pick the right execution mode (this bites people)
| mode | command | use for |
|---|---|---|
| commandlet | `UnrealEditor-Cmd <proj> -run=pythonscript -script=x.py` | fast, write-only asset work. **Interchange's async API crashes here** |
| full editor headless | `UnrealEditor <proj> -ExecutePythonScript=x.py` | **imports** — everything works; ~60–120s startup |
| exec cmds | `UnrealEditor <proj> -ExecCmds="py x.py"` | long pipelines; editor stays open |

`AssetImportTask` is the safe path in all modes — for glTF it routes through
Interchange internally without the async crash. Prefer it over calling Interchange
directly. Always finish with `unreal.EditorAssetLibrary.save_all_dirty_packages()`.

## The one function you'll reuse constantly
```python
import unreal

def import_asset(path, dest, options=None, factory=None):
    task = unreal.AssetImportTask()
    task.set_editor_property('automated', True)
    task.set_editor_property('filename', path)
    task.set_editor_property('destination_path', dest)   # e.g. '/Game/Imported/Props'
    task.set_editor_property('replace_existing', True)
    task.set_editor_property('save', True)
    if options: task.set_editor_property('options', options)
    if factory: task.set_editor_property('factory', factory)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return task.get_editor_property('imported_object_paths')
```

## Per format
- **glTF/GLB** — just `import_asset('x.glb', '/Game/Imported')`. No options object needed.
- **FBX static mesh** — `unreal.FbxImportUI()` with `import_as_skeletal=False`,
  `import_materials=True`; on `static_mesh_import_data` set `combine_meshes=True`.
- **FBX skeletal + animation** — `import_as_skeletal=True`, `import_animations=True`,
  `create_physics_asset=True`.
- **Animation-only FBX** — `import_mesh=False`, `import_as_skeletal=True`, and you
  MUST set `options.skeleton = unreal.load_asset('/Game/.../SK_Mannequin')`.
- **Textures** — PNG/JPG/TGA/EXR/HDR/PSD/DDS all native. For normal maps pass a
  `unreal.TextureFactory()` with `compression_settings=TC_NORMAL_MAP`.
- **HDRI** — a `.hdr`/`.exr` equirect imports **directly as a TextureCube**; no
  manual conversion. Assign to a SkyLight with Source Type = *SLS Specified Cubemap*.
- **Audio** — **16-bit PCM WAV only**. MP3/OGG/FLAC are rejected; convert first:
  `ffmpeg -i in.mp3 -acodec pcm_s16le -ar 44100 out.wav`.

## Retargeting mocap onto a skeleton (Python — this works)
```python
tools = unreal.AssetToolsHelpers.get_asset_tools()
rtg = tools.create_asset('RTG_Mocap', '/Game/Retargeters/',
                         unreal.IKRetargeter, unreal.IKRetargetFactory())
c = unreal.IKRetargeterController.get_controller(rtg)
c.set_ik_rig(unreal.RetargetSourceOrTarget.SOURCE, unreal.load_asset('/Game/.../IK_Source'))
c.set_ik_rig(unreal.RetargetSourceOrTarget.TARGET, unreal.load_asset('/Game/Characters/Mannequins/Rigs/IK_Mannequin'))
c.auto_map_chains(unreal.AutoMapChainType.FUZZY, True)          # fuzzy name matching
unreal.IKRetargetBatchOperation.duplicate_and_retarget(
    anim_asset_datas, None, None, rtg, '', '', '', '_rt', True)
```

## PCG and levels
- PCG graphs can be created and have nodes added from Python
  (`unreal.PCGGraph` + `PCGGraphFactory`), but **not every node property is
  settable from Python** — complex graphs are easier authored in-editor then driven.
- Level/actor manipulation (`EditorLevelLibrary`, `EditorActorSubsystem`,
  SkyLight assignment) needs **full-editor mode**, not the commandlet.
- MetaSounds have no Python graph-authoring API — import WAVs and play them, or
  build MetaSound graphs in the editor.
