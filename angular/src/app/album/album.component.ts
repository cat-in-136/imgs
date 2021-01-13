import {Component, HostListener, OnInit, SecurityContext} from '@angular/core';
import {ActivatedRoute, NavigationEnd, Router} from '@angular/router';
import {AngularFireStorage} from '@angular/fire/storage';
import {HttpClient} from '@angular/common/http';
import {DomSanitizer, SafeUrl} from '@angular/platform-browser';
import {combineLatest} from 'rxjs';
import {JobQueue} from '../job/job-queue';
import {TitleService} from '../service/title.service';
import * as JSZip from 'jszip';
import * as FileSaver from 'file-saver';
import {DecryptedImage} from '../model/decrypted-image';

class UploadingFile {
  encryptedBuffer: ArrayBuffer;

  constructor(public readonly name: string, public readonly buffer: ArrayBuffer) {

  }

  toDecryptedImage(sanitizer: DomSanitizer): DecryptedImage {
    return new DecryptedImage(this.name, this.buffer, sanitizer);
  }
}

@Component({
  selector: 'app-album',
  templateUrl: './album.component.html',
  styleUrls: ['./album.component.sass']
})
export class AlbumComponent implements OnInit {

  get uploadable(): boolean {
    // 読み込み中か || ファイルリストを持っていないか || 持っているがファイルリストを復号できる正当な鍵を持っている場合に投稿可能
    return !this.loading && (!this.hasFileList || (this.hasFileList && this.validFileList));
  }

  get editable(): boolean {
    // エディット機能が有効もしくは画像の投稿がないとき
    return this.showEdit || this.fileList.length === 0;
  }

  get currentImage(): DecryptedImage {
    return this.imageList[this.fileList.indexOf(this.currentImageName)];
  }

  constructor(
    private router: Router,
    private route: ActivatedRoute,
    private storage: AngularFireStorage,
    private http: HttpClient,
    private sanitizer: DomSanitizer,
    private title: TitleService
  ) {
    this.router.events.subscribe(async value => {
      if (!(value instanceof NavigationEnd)) {
        return;
      }

      if (this.route.firstChild == null) {
        this.currentImageName = null;
        return;
      }
      const photoParams = await this.route.firstChild.snapshot.params;
      this.currentImageName = photoParams.photo_id;
    });
  }

  readQueue: JobQueue = new JobQueue('read');
  encryptQueue: JobQueue = new JobQueue('encrypt');
  uploadQueue: JobQueue = new JobQueue('upload');

  uploadFiles: File[] = [];
  completedCount = 0;
  loadCompletedCount = 0;
  key: string;
  fileList: string[] = [];

  loading = false;
  hasFileList: boolean;
  validFileList: boolean;

  keyPromise: PromiseLike<CryptoKey>;

  album_id: string;
  imageList: DecryptedImage[] = [];
  showPhotoDateTime = false;
  showPhotoDetail = false;
  showEdit = false;

  currentImageName: string;

  static stringToBuffer(src: string): ArrayBufferLike {
    return (new Uint16Array([].map.call(src, function (c: string) {
      return c.charCodeAt(0);
    }))).buffer;
  }

  static bufferToString(buf: ArrayBufferLike): string {
    return String.fromCharCode.apply('', new Uint16Array(buf));
  }

  static concat(buffer1: ArrayBuffer, buffer2: ArrayBuffer): ArrayBuffer {
    const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
    tmp.set(new Uint8Array(buffer1), 0);
    tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
    return tmp.buffer as ArrayBuffer;
  }

  ngOnInit() {
    combineLatest(
      this.route.fragment,
      this.route.params
    ).subscribe(value => {
      this.key = value[0].substring(2);
      this.album_id = value[1].album_id;
      this.title.setTitle(this.album_id);
      this.keyPromise = this.importKey();
      return this.loadFileList();
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown($event: KeyboardEvent) {
    if (this.currentImageName != null) {
      const index = this.fileList.indexOf(this.currentImageName);
      if ($event.key === 'ArrowRight') {
        this.currentImageName = this.fileList[Math.min(this.fileList.length - 1, index + 1)];
      }
      if ($event.key === 'ArrowLeft') {
        this.currentImageName = this.fileList[Math.max(0, index - 1)];
      }
    }
  }

  dndFiles(event: DragEvent) {
    try {
      const fileItems = [];
      for (let i = 0; i < event.dataTransfer.items.length; i++) {
        if (event.dataTransfer.items[i].kind === 'file') {
          fileItems.push(event.dataTransfer.items[i]);
        }
      }
      if (fileItems.length === 0) {
        return; // ファイルをドラッグアンドドロップしていないのならば処理しない
      }

      event.stopPropagation();
      event.preventDefault();
      if (event.type === 'dragover') {
        event.dataTransfer.dropEffect = 'copy';
      } else if (event.type === 'drop') {
        this.append(fileItems.map(item => item.getAsFile()));
      }
    } catch (e) {
      console.error(e);
    }
  }

  async loadFileList() {
    if (this.loading) {
      return;
    }
    if (!this.key || !this.album_id) {
      return;
    } // idと鍵の双方が存在しないと
    try {
      this.loading = true;
      const ref = this.storage.ref(this.album_id + '/filelist');
      this.hasFileList = false;
      const url = await ref.getDownloadURL().toPromise();
      this.hasFileList = true;
      const response = await this.http.get(url, {responseType: 'arraybuffer'}).toPromise();
      const iv = response.slice(0, 12);
      const data = response.slice(12);
      const key = await this.keyPromise;
      this.validFileList = false;
      const decrypted = await window.crypto.subtle.decrypt({
        name: 'AES-GCM',
        iv: iv
      }, key, data);
      this.validFileList = true;
      const json = AlbumComponent.bufferToString(decrypted);
      this.fileList = JSON.parse(json);
      this.imageList = [];
      this.loadCompletedCount = 0;
      this.fileList.forEach(async name => {
        const image = await this.loadImage(name);
        const index = this.fileList.indexOf(name);
        this.imageList[index] = image;
        this.loadCompletedCount += 1;
      });
    } catch (e) {
      console.error(e);
    }
    this.loading = false;
  }

  append(files: FileList | File[]) {
    // 重複チェック
    for (let i = 0; i < files.length; i++) {
      if (this.fileList.indexOf(files[i].name) >= 0) {
        alert('すでに登録済みの名前のファイルが選択されています。処理を中止します。');
        return;
      }
    }

    for (let i = 0; i < files.length; i++) {
      this.uploadFiles.push(files[i]);
      this.readQueue.enqueue(async () => {
        const file = files[i];
        const buffer = await new Promise<ArrayBuffer>(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as ArrayBuffer);
          reader.readAsArrayBuffer(file);
        });
        const uploadingFile = new UploadingFile(file.name, buffer);
        this.enqueueCrypto(uploadingFile);
      });
    }
  }

  enqueueCrypto(file: UploadingFile) {
    this.encryptQueue.enqueue(async () => {
      console.log('do enc');
      const iv = window.crypto.getRandomValues(new Uint8Array(12));

      const key = await this.keyPromise;
      const encrypted = await window.crypto.subtle.encrypt({
        name: 'AES-GCM',
        iv: iv,
      }, key, file.buffer);

      file.encryptedBuffer = AlbumComponent.concat(iv.buffer as ArrayBuffer, encrypted);
      this.enqueueUpload(file);
    });
  }

  enqueueUpload(file: UploadingFile) {
    this.uploadQueue.enqueue(async () => {
      const ref = this.storage.ref(this.album_id + '/' + file.name);
      await ref.put(file.encryptedBuffer);
      this.fileList.push(file.name);
      await this.updateFileList();
      this.completedCount += 1;

      const decryptedImage = file.toDecryptedImage(this.sanitizer);
      const tags = decryptedImage.tags;
      if (tags && tags['Orientation'] && tags['Orientation'] !== 1) {
        const rotated = await this.rotate(decryptedImage.originalImageUrl, tags);
        decryptedImage.url = this.sanitizer.bypassSecurityTrustUrl(rotated);
      } else {
        // canvas.toBlob() (this.rotate())は重い処理なので不要な場合（Orientation=1）は行わない
      }

      const index = this.fileList.indexOf(decryptedImage.name);
      this.imageList[index] = decryptedImage;
      this.loadCompletedCount += 1;
    });
  }

  importKey(): PromiseLike<CryptoKey> {
    return window.crypto.subtle.importKey(
      'jwk',
      {
        kty: 'oct',
        k: this.key,
        alg: 'A256GCM',
        ext: true,
      },
      {
        name: 'AES-GCM',
        length: 256
      },
      false, // whether the key is extractable (i.e. can be used in exportKey)
      ['encrypt', 'decrypt'] // can "encrypt", "decrypt", "wrapKey", or "unwrapKey"
    );
  }

  // ファイルリストの更新
  async updateFileList() {

    this.fileList = this.fileList.filter((x, i, self) => self.indexOf(x) === i); // 重複を排除
    const json = JSON.stringify(this.fileList);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const key = await this.keyPromise;
    const decrypted = await window.crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: iv,
    }, key, AlbumComponent.stringToBuffer(json) as ArrayBuffer);

    const ref = this.storage.ref(this.album_id + '/filelist');
    ref.put(AlbumComponent.concat(iv.buffer as ArrayBuffer, decrypted));
  }

  async loadImage(name: string) {
    if (name == null) {
      return;
    }
    const ref = this.storage.ref(this.album_id + '/' + name);
    const url = await ref.getDownloadURL().toPromise();
    const buffer = await this.http.get(url, {responseType: 'arraybuffer'}).toPromise();
    const key = await this.keyPromise;
    const iv = buffer.slice(0, 12);
    const data = buffer.slice(12);
    const dec = await window.crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv: iv,
    }, key, data);

    const decryptedImage = new DecryptedImage(name, dec, this.sanitizer);

    if (CSS.supports('image-orientation: from-image')) {
      // image-orientation: from-image に対応しているならば、CSS に任せると早くなる
      // しかし廃止の見込み、UA が EXIF を読むのが正しくなる
      // https://drafts.csswg.org/css-images-3/#the-image-orientation
      // https://drafts.csswg.org/css-images-4/#image-notation
    } else {
      const tags = decryptedImage.tags;
      if (tags && tags['Orientation'] && tags['Orientation'] !== 1) {
        const rotated = await this.rotate(decryptedImage.originalImageUrl, tags);
        decryptedImage.url = this.sanitizer.bypassSecurityTrustUrl(rotated);
      } else {
        // canvas.toBlob() (this.rotate())は重い処理なので不要な場合（Orientation=1）は行わない
      }
    }

    return decryptedImage;
  }

  // see: https://stackoverflow.com/questions/20600800/js-client-side-exif-orientation-rotate-and-mirror-jpeg-images/31273162#31273162
  async rotate(url: SafeUrl, tags: any) {
    const canvas = document.createElement('canvas');

    const ctx = canvas.getContext('2d');
    const width = tags['PixelXDimension'];
    const height = tags['PixelYDimension'];
    const orientation = tags['Orientation'];

    const img = await new Promise<any>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = (err) => reject(err);
      image.src = this.sanitizer.sanitize(SecurityContext.URL, url);
    });

    img.width = width;
    img.height = height;

    if ([5, 6, 7, 8].indexOf(orientation) > -1) {
      canvas.width = img.height;
      canvas.height = img.width;
    } else {
      canvas.width = img.width;
      canvas.height = img.height;
    }

    switch (orientation) {
      case 2:
        ctx.transform(-1, 0, 0, 1, img.width, 0);
        break;
      case 3:
        ctx.transform(-1, 0, 0, -1, img.width, img.height);
        break;
      case 4:
        ctx.transform(1, 0, 0, -1, 0, img.height);
        break;
      case 5:
        ctx.transform(0, 1, 1, 0, 0, 0);
        break;
      case 6:
        ctx.transform(0, 1, -1, 0, img.height, 0);
        break;
      case 7:
        ctx.transform(0, -1, -1, 0, img.height, img.width);
        break;
      case 8:
        ctx.transform(0, -1, 1, 0, 0, img.width);
        break;
    }
    ctx.drawImage(img, 0, 0);
    const type = 'image/jpeg';
    const blob = await new Promise<Blob>(resolve => {
      if (canvas.toBlob) {
        canvas.toBlob(result => resolve(result), type);
      } else {
        const dataURL = canvas.toDataURL(type);
        const bin = atob(dataURL.split(',')[1]);
        const buffer = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
          buffer[i] = bin.charCodeAt(i);
        }
        resolve(new Blob([buffer.buffer as ArrayBuffer], {type: type}));
      }
    });
    return URL.createObjectURL(blob);
  }

  async downloadAsZip() {
    const zip = new JSZip();
    for (const image of this.imageList) {
      zip.file(image.name, image.decryptedData, {binary: true});
    }
    const zipFile = await zip.generateAsync({type: 'blob'});
    FileSaver.saveAs(zipFile, `Photos-${this.album_id}.zip`);
  }

  async delete(image: DecryptedImage) {
    const b = confirm('本当に削除してよろしいですか？');
    if (!b) { return; }
    const ref = this.storage.ref(this.album_id + '/' + image.name);
    await ref.delete();

    this.fileList.splice(this.fileList.indexOf(image.name), 1);
    await this.updateFileList();

    this.imageList.splice(this.imageList.indexOf(image), 1);
  }

  gotoPhoto(image: DecryptedImage) {
    this.router.navigate([this.album_id, image.name], {fragment: 'k=' + this.key});
  }
}

