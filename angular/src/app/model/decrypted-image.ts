import {DomSanitizer, SafeUrl} from '@angular/platform-browser';
import * as EXIF from 'exif-js/exif';

export class DecryptedImage {
  readonly decryptedData: ArrayBuffer;
  url: SafeUrl;
  readonly originalImageUrl: SafeUrl;
  readonly tags: any;
  showFullExif = false;

  constructor(
    public readonly name: string,
    public readonly dec: ArrayBuffer,
    readonly sanitizer: DomSanitizer
  ) {
    const blob = new Blob([dec], {type: 'image/jpeg'});
    const dataURL = URL.createObjectURL(blob);

    this.name = name;
    this.decryptedData = dec;
    this.originalImageUrl = sanitizer.bypassSecurityTrustUrl(dataURL);
    this.url = this.originalImageUrl;
    this.tags = EXIF.readFromBinaryFile(dec);
  }

  get orientation(): number {
    if (this.tags == null) {
      return null;
    }

    return this.tags['Orientation'];
  }

  get exposureTime(): string {
    if (this.tags == null) {
      return null;
    }

    // 1秒以上のときはそのまま
    if (this.tags['ExposureTime'] >= 1) {
      return this.tags['ExposureTime'];
    }

    return '1/' + (1 / this.tags['ExposureTime']);
  }
}
