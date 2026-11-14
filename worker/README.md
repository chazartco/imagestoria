# ImageStoria worker

A program for a machine of your own, usually one with an NVIDIA GPU, that reads the pictures in an
ImageStoria library. It asks the site for work, fetches the pictures it is given, and sends back what it
found. No picture goes to an outside service. The site never connects to this machine, so it runs
behind a home router with nothing opened.

What it can do, each one a task you turn on in the config file:

| Task | What it adds to the site | What runs it |
|---|---|---|
| `caption` | A caption, the scene, what is in the picture, readable text | A vision model behind a local model server |
| `embed` | Search by meaning, "More like this", near duplicates | An image and text model, with ONNX Runtime |
| `faces` | People: faces to group and name | A face detector and recogniser, with ONNX Runtime |
| `place` | A guess at where a picture with no location was taken | The same vision model as `caption` |

## The recommended setup

This is what `worker.example.toml` holds, and what was measured on a 16 GB NVIDIA card. It is the
setup to start from.

| Part | Choice | Why |
|---|---|---|
| Model server | Ollama, context length 8192 | Needs no administrator rights. 4096, its default on a 16 GB card, is tight |
| Vision model | `qwen3.5:9b-q4_K_M` (6.6 GB, Apache 2.0) | Chosen from the bench: the best descriptions, and it named the subjects right where the faster model did not |
| Thinking | Off (`reasoning_effort = "none"`) | Several times faster, and no empty answers |
| Answer limit | `max_tokens = 700` | Stops a model that starts repeating itself |
| Picture size | `max_edge = 1024` | What the bench was run at |
| Tasks | `caption`, `embed`, `faces`, `place` | Everything the site can use |
| Batch | 4 | Each picture is handed in as soon as it is read |
| Search by meaning | `onnx-community/siglip2-base-patch16-224-ONNX` (Apache 2.0) | Must match the site's `EMBED_MODEL` |
| Faces | `open`: YuNet and AuraFace v1 (MIT, Apache 2.0) | May be used for anything |
| Face cut-offs | `min_size = 40`, `min_sharpness = 80`, `min_score = 0.6` | Set on a real library |

Speed on that card, on a library of about 1,100 items: a caption 3.4 s, an embedding under 0.1 s, the
faces of a picture 0.4 s including fetching the original. About an hour for captions, a few minutes
for the rest.

On a 24 GB card the same setup runs as it is. `qwen3.5:27b-q4_K_M` (17 GB) is the larger model of the
same family. Try it on the bench before changing to it.

## Set it up

You need Windows 10 or 11, or Linux (WSL works). An NVIDIA GPU with a current driver is assumed. It
also runs on a CPU, slowly.

1. **A model server for the vision model.** Any server that speaks the OpenAI chat API works: Ollama,
   the llama.cpp server, or vLLM. With Ollama:
   - Windows: run `OllamaSetup.exe` from ollama.com. It needs no administrator rights.
   - Linux: follow ollama.com/download, or run it in Docker:
     `docker run -d --gpus=all -e OLLAMA_CONTEXT_LENGTH=8192 -v ollama:/root/.ollama -p 127.0.0.1:11434:11434 --name ollama ollama/ollama`
   - Then fetch the model: `ollama pull qwen3.5:9b-q4_K_M`
   - Set the context length to 8192 (`OLLAMA_CONTEXT_LENGTH=8192`). Ollama picks 4096 on a card under
     24 GB, which is tight for a picture and its answer.
2. **The worker.** In this folder:
   - Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`
   - Linux: `sh install.sh`

   This installs `uv` for your user if it is missing, makes a Python 3.12 environment in `.venv`, and
   installs the worker with ONNX Runtime for the GPU. The NVIDIA libraries come from pip, so there is
   no separate CUDA install. For a machine with no NVIDIA GPU, pass `cpu`: `sh install.sh cpu`.
3. **A token.** On the site open People and settings, go to Workers, name this machine and press
   Make a token. It is shown once.
4. **The config file.** The install made `worker.toml` from `worker.example.toml`, which holds the
   recommended setup. Put in the site's address and the token. Nothing else needs changing.
5. **Check it:** `sh run.sh check` (Windows: `.\run.ps1 check`). It says whether the site, the token,
   the model server and the GPU are all there.
6. **Run it:** `sh run.sh` (Windows: `.\run.ps1`). Stop it with Ctrl+C. It finishes the picture in
   hand and gives the rest back.

The first run of `embed` or `faces` fetches its models from Hugging Face into `models/`: about 370 MB
for search by meaning and about 260 MB for faces.

## Moving it to another machine

Copy this folder without `.venv`, or clone the repository there, and run the install again. Then
either copy `worker.toml` across, or better, make a new token for the new machine and revoke the old
one. Copying `models/` saves the downloads.

## Keeping it running

The worker holds nothing on disk that matters. After a reboot it asks the site for work and carries on.

- **Windows:** make it start when you sign in:
  `schtasks /Create /TN "ImageStoria worker" /SC ONLOGON /TR "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\path\to\worker\run.ps1"`
- **Linux:** a user service. Save this as `~/.config/systemd/user/afterimage-worker.service`, then run
  `systemctl --user enable --now afterimage-worker` and `loginctl enable-linger $USER`.

  ```ini
  [Unit]
  Description=ImageStoria worker
  After=network-online.target

  [Service]
  WorkingDirectory=/path/to/worker
  ExecStart=/path/to/worker/.venv/bin/python -m afterimage_worker
  Restart=always
  RestartSec=30

  [Install]
  WantedBy=default.target
  ```

## How it behaves

- **It is polite.** When the site or the model server is away it waits 5 seconds, then 10, doubling
  to 5 minutes, and carries on by itself when they are back. It checks the model server before it
  takes work, so an outage does not use up tries.
- **Working hours.** `hours = "22:00-07:00"` makes it work only at night, on this machine's clock.
- **One line per item** goes to the screen and to `worker.log`:
  `2026-11-12 03:17:50 item 234bacbe caption 1.8s coast, 9 objects: A wide shot of ...`
- **A picture it cannot read** is reported to the site with the reason. The site tries it again, three
  times in all, then marks it failed and shows the count in the Workers section.
- **Pause** on the site stops it taking work. **Revoke** ends its token. It then waits five minutes
  between tries, so a new token in the config file is picked up on the next start.
- **Changing models** is a line in `worker.toml`. Press "Read everything again" on the site to redo old
  pictures. Whatever a person corrected by hand is kept.
- **Thinking is off by default** (`reasoning_effort = "none"` under `[vision.extra]`). Most current
  vision models think before answering. For describing a picture that is several times slower, and now
  and then a model thinks until it runs out of room and answers nothing.

## Choosing the vision model

`qwen3.5:9b-q4_K_M` is the recommended model. It was not picked on paper: four candidates were run on
200 photos from a real library, and the answers were read side by side.

| Model | Seconds a picture | Read | Failed | What was found |
|---|---|---|---|---|
| `qwen3.5:9b-q4_K_M` | 3.4 | 200 | 0 | The best descriptions. It named the kind of bird right about 8 times in 10 |
| `gemma4:12b-it-q4_K_M` | 1.8 | 200 | 0 | Twice as fast. It named the same birds wrong about 9 times in 10 |
| `bonsai-2:27b` | 4.3 | 200 | 0 | Not chosen |
| `qwen3-vl:8b` | 11.9 | 12 | 188 | Not usable with these settings: it answered with no JSON |

Speed is not the thing to choose by. Do the same on your own photos before changing models:

```sh
ollama pull qwen3.5:9b-q4_K_M && ollama pull gemma4:12b-it-q4_K_M && ollama pull bonsai-2:27b
sh run.sh bench --models "qwen3.5:9b-q4_K_M,gemma4:12b-it-q4_K_M,bonsai-2:27b" --folder /path/to/200/photos --out bench
```

`--add` adds a model to a page an earlier run wrote for the same pictures.

Open `bench/index.html`. It shows every picture with each model's caption, scene, objects and text,
and a table of speed, failures and GPU memory. `--from-site 200` borrows pictures from the site
instead of a folder. It only works while pictures are still waiting to be read, and gives them back
untouched.

Licences of the models tried in November 2026, as their publishers state them. Check them yourself
before relying on them.

| Model | Size | Licence |
|---|---|---|
| `qwen3.5:9b-q4_K_M` (Alibaba), recommended | 6.6 GB | Apache 2.0 |
| `gemma4:12b-it-q4_K_M` (Google) | 8.0 GB | Apache 2.0 |
| `qwen3-vl:8b` (Alibaba) | 6.2 GB | Apache 2.0 |
| `bonsai-2:27b` (Prism ML) | 8.3 GB | Apache 2.0 |

On a 24 GB card the larger variants fit: `qwen3.5:27b-q4_K_M` (17 GB), `gemma4:26b-a4b-it-qat` (16 GB).

## Search by meaning

`[embed]` names the image and text model. The site runs the text half of the same model, so the name
must match the site's `EMBED_MODEL` setting. The site refuses an embedding from a different model and
says so. The default is SigLIP 2 base (`onnx-community/siglip2-base-patch16-224-ONNX`, Apache 2.0).

## People, and the licences of face models

`models` under `[faces]` chooses between two sets:

- **`open`** (the default): YuNet for finding faces (MIT licence) and AuraFace v1 for telling them
  apart (Apache 2.0). They may be used for anything. AuraFace's publisher says it was trained on data
  that allows commercial use. It does not name the data.
- **`insightface`**: the InsightFace `buffalo_l` pack. It is more accurate on hard pictures such as
  faces in profile. InsightFace says: "The pretrained models provided with this library are for
  non-commercial research only." So this is for your own library, and not for a product you ship.
  Install the extra packages with `sh install.sh "gpu,insightface"`.

Numbers from the two sets cannot be compared. After changing sets, press "Read everything again" for
People on the site. Names a person gave are kept where the face is still found in the same place.

A face is left out when it is under `min_size` pixels on its shorter side (40), when it is blurred
(`min_sharpness`, 80 on a scale where a sharp face scores in the thousands), or when the detector is
under `min_score` sure it is a face (0.6). A large picture is looked at whole and then again in
overlapping parts, so small faces in a group are found. Faces are read from the original file by
default, and from the site's 1600 px copy when the original is a format this machine cannot open.

## Videos

A video is read from its poster frame, the one still the site made when it was uploaded. Doing better
needs frames sampled along the video, a caption per frame merged into one, and for people the best
face per person across frames. The site would have to hand out those frames, or the worker would have
to download the whole video and cut them with ffmpeg.

## Tests

```sh
.venv/bin/python -m unittest discover -s tests
```

They run against a stand-in site and a stand-in model server. No GPU and no network are needed.
